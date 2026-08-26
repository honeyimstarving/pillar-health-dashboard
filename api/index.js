const express = require('express');
const fetch   = require('node-fetch');
const https   = require('https');
const cors    = require('cors');
const app     = express();
app.use(cors());
app.use(express.json());

// Disable connection pooling/keep-alive for CTM calls — avoids "Premature close"
// errors caused by reusing a socket the server has already closed on its end.
const noKeepAliveAgent = new https.Agent({ keepAlive: false });

// ── CTM CREDENTIALS (Railway env vars) ──────────────
const CTM_ACCESS_KEY = process.env.CTM_ACCESS_KEY;
const CTM_SECRET_KEY = process.env.CTM_SECRET_KEY;
const CTM_ACCOUNT_ID = process.env.CTM_ACCOUNT_ID; // 597239

// ── CAMPAIGN CONFIG ──────────────────────────────────
const CAMPAIGNS = [
  { campaign: 'CaPillar Cobra', numbers: ['+18777136513', '+18889835332', '+18882824215', '+18883102849'] },
  { campaign: 'CaPillar Emerald', numbers: ['+18778651763', '+18777632129', '+18773314164', '+18886399178', '+18773528261', '+18889909367'] },
  { campaign: 'Life Happens',   numbers: ['+18889645703', '+18885267409', '+18774164461'] },
  { campaign: 'Ruby',           numbers: ['+18777028985', '+18887992605', '+18886706511', '+18886229281'] },
];

const ALL_NUMBERS = CAMPAIGNS.flatMap(c => c.numbers);

// ── Fetch with retry (handles transient network blips like "Premature close") ──
async function fetchWithRetry(url, options, retries = 3, delayMs = 500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const transient = /premature close|socket hang up|ECONNRESET|ETIMEDOUT/i.test(err.message || '');
      if (!transient || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

// ── CTM call log fetch ───────────────────────────────
async function fetchCTMCalls(dateFrom, dateTo) {
  if (!CTM_ACCESS_KEY || !CTM_SECRET_KEY || !CTM_ACCOUNT_ID) {
    throw new Error('CTM_ACCESS_KEY, CTM_SECRET_KEY, and CTM_ACCOUNT_ID env vars are required');
  }

  const authHeader = 'Basic ' + Buffer.from(`${CTM_ACCESS_KEY}:${CTM_SECRET_KEY}`).toString('base64');
  const allCalls = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const params = new URLSearchParams({
      page:       String(page),
      per_page:   String(perPage),
      start_date: dateFrom,
      end_date:   dateTo,
      start:      dateFrom,
      end:        dateTo,
    });

    const url = `https://app.calltrackingmetrics.com/api/v1/accounts/${CTM_ACCOUNT_ID}/calls?${params}`;
    const res = await fetchWithRetry(url, {
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Connection': 'close' },
      agent: noKeepAliveAgent,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CTM API ${res.status}: ${body}`);
    }

    const data = await res.json();
    const calls = data.calls || data.data || [];
    allCalls.push(...calls);

    // Pagination stop conditions — do NOT rely on a total-count field (CTM's
    // calls-search envelope doesn't reliably include one; treating a missing
    // count as 0 previously broke the loop after page 1 and truncated the day).
    const totalPages = parseInt(data.total_pages || data.page_count || 0);
    const curPage    = parseInt(data.page || page);

    if (calls.length === 0) break;
    if (totalPages && curPage >= totalPages) break;
    if (!totalPages && calls.length < perPage) break;
    page++;
    if (page > 100) break;
  }

  // Filter to only our tracked numbers
  const targetSet = new Set(ALL_NUMBERS.map(n => n.replace(/\D/g, '')));
  return allCalls.filter(call => targetSet.has(trackedNumberOf(call)));
}

// ── Field helpers ────────────────────────────────────
// The tracking number the call came in on (digits only).
function trackedNumberOf(call) {
  return String(call.tracking_number || call.tracking_phone_number || call.receiving_number || '').replace(/\D/g, '');
}

// The caller's own number (digits only).
function callerNumberOf(call) {
  return String(call.caller_number || call.caller_number_e164 || call.caller || call.from_number || call.from || '').replace(/\D/g, '');
}

function timestampOf(call) {
  const raw = call.called_at || call.start_time || call.created_at || call.date || null;
  const t = raw ? Date.parse(raw) : NaN;
  return isNaN(t) ? 0 : t;
}

// ── Filters: inbound voice only ──────────────────────
// Returns true / false / null(unknown). Unknown is KEPT, but counted in
// diagnostics so a missing field can't silently drop or pad the number.
function inboundState(call) {
  const raw = call.direction ?? call.call_direction ?? call.type_of_call ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const d = String(raw).toLowerCase();
  if (d.startsWith('in'))  return true;
  if (d.startsWith('out')) return false;
  return null;
}

// CTM returns texts, chats and form submissions through the same /calls
// collection. Anything that isn't a voice call is excluded.
const NON_VOICE = /text|sms|chat|form|message|email/i;
function voiceState(call) {
  const raw = call.type ?? call.call_type ?? call.medium ?? call.channel ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  return !NON_VOICE.test(String(raw));
}

function isInboundVoice(call) {
  // Calls flagged as excluded in CTM shouldn't reach any reporting metric.
  if (call.excluded === true || call.excluded === 'true') return false;
  return inboundState(call) !== false && voiceState(call) !== false;
}

// ── First-time-caller detection ──────────────────────
// Three possible signals, in order of trustworthiness:
//   'field'  — CTM sends an explicit boolean on the call object
//   'tag'    — CTM's "First Time Caller" auto-tag is enabled on the account
//   'dedup'  — neither is available; fall back to deduping caller numbers
//              inside the window. THIS OVERCOUNTS (a repeat caller whose first
//              call predates the window looks new) and is reported as such.
function firstTimeField(call) {
  // CTM's native boolean. `is_new_caller` is the one this account actually
  // sends; the others are kept as fallbacks across CTM versions. Preferred over
  // the "First Time Caller" auto-tag because it can't be switched off by an
  // edit to the account's tag rules.
  const v = call.is_new_caller ?? call.first_time_caller ?? call.is_first_time_caller ?? call.first_time ?? null;
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (s === 'true'  || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no')  return false;
  return null;
}

function hasFirstTimeTag(call) {
  const tags = call.tags || call.tag_list || call.labels || '';
  const tagStr = Array.isArray(tags)
    ? tags.map(t => (typeof t === 'string' ? t : (t && (t.name || t.tag)) || '')).join('|')
    : String(tags);
  return /first[\s_-]*time[\s_-]*caller/i.test(tagStr);
}

function hasAnyTags(call) {
  const tags = call.tags || call.tag_list || call.labels || '';
  return Array.isArray(tags) ? tags.length > 0 : String(tags).trim().length > 0;
}

// Decide which signal this dataset actually supports.
function detectMode(calls) {
  let fieldCount = 0, tagCount = 0, taggedAtAll = 0;
  for (const c of calls) {
    if (firstTimeField(c) !== null) fieldCount++;
    if (hasFirstTimeTag(c)) tagCount++;
    if (hasAnyTags(c)) taggedAtAll++;
  }
  if (fieldCount > 0) return { mode: 'field', fieldCount, tagCount, taggedAtAll };
  // Only trust the tag if the auto-tag is clearly live on the account — if not a
  // single call carries it, assume it's switched off rather than reporting zero.
  if (tagCount > 0) return { mode: 'tag', fieldCount, tagCount, taggedAtAll };
  return { mode: 'dedup', fieldCount, tagCount, taggedAtAll };
}

function isFirstTime(call, mode) {
  if (mode === 'field') return firstTimeField(call) === true;
  if (mode === 'tag')   return hasFirstTimeTag(call);
  return true; // dedup mode decides at the set level, not per call
}

// ── Core counting ────────────────────────────────────
// Reduces raw CTM rows to ONE row per first-time inbound caller — the earliest
// qualifying call from that number. Campaign attribution comes from that same
// row, so per-campaign counts always sum to the total.
function firstTimeCallers(calls, mode) {
  const qualifying = calls
    .filter(isInboundVoice)
    .filter(call => isFirstTime(call, mode));

  const byCaller = new Map();
  const noNumber = [];

  for (const call of qualifying) {
    const caller = callerNumberOf(call);
    if (!caller) {
      // Unreadable caller number: only countable if an explicit signal marked it.
      if (mode !== 'dedup') noNumber.push(call);
      continue;
    }
    const existing = byCaller.get(caller);
    if (!existing || timestampOf(call) < timestampOf(existing)) {
      byCaller.set(caller, call);
    }
  }

  return [...byCaller.values(), ...noNumber];
}

function campaignOf(call) {
  const num = trackedNumberOf(call);
  for (const camp of CAMPAIGNS) {
    if (camp.numbers.some(n => n.replace(/\D/g, '') === num)) return camp.campaign;
  }
  return null;
}

function isConnectedCall(call) {
  if (call.answered === true || call.answered === 'true') return true;
  if (call.connected === true) return true;
  if (String(call.status || '').toLowerCase() === 'answered') return true;
  const talk = parseInt(call.talk_time || 0);
  return talk > 0;
}

// ── /api/calls endpoint ──────────────────────────────
app.all('/api/calls', async (req, res) => {
  try {
    const body = { ...req.query, ...req.body };
    const start = body.start || body.dateFrom;
    const end   = body.end   || body.dateTo;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const raw = await fetchCTMCalls(start, end);
    const detection = detectMode(raw);
    const mode = detection.mode;

    const firstTime = firstTimeCallers(raw, mode);
    const uniqueTotal = firstTime.length;

    const connected = firstTime.filter(isConnectedCall);
    const connectRate = uniqueTotal > 0
      ? ((connected.length / uniqueTotal) * 100).toFixed(1)
      : '0.0';

    // Duration averaged over the same set that produces the count, EXCLUDING
    // rows with no usable duration. In-progress/ringing calls come back with
    // duration:null, which would otherwise average in as zero and understate it.
    let totalDurationSec = 0;
    let durationSamples  = 0;
    for (const call of firstTime) {
      const raw = call.duration_in_seconds ?? call.duration ?? call.talk_time ?? null;
      if (raw === null || raw === undefined || raw === '') continue;
      const secs = parseInt(raw);
      if (isNaN(secs)) continue;
      totalDurationSec += secs;
      durationSamples++;
    }
    const avgDurSec    = durationSamples > 0 ? Math.round(totalDurationSec / durationSamples) : 0;
    const avgDurMin    = Math.floor(avgDurSec / 60);
    const avgDurSecRem = String(avgDurSec % 60).padStart(2, '0');

    // Per-campaign breakdown — each caller counted once, in the campaign of
    // their earliest qualifying call. Rows sum to the total by construction.
    const buckets = new Map(CAMPAIGNS.map(c => [c.campaign, []]));
    for (const call of firstTime) {
      const name = campaignOf(call);
      if (name && buckets.has(name)) buckets.get(name).push(call);
    }

    const campaignData = CAMPAIGNS.map(camp => {
      const campCalls = buckets.get(camp.campaign) || [];
      return {
        campaign:       camp.campaign,
        totalCalls:     campCalls.length,
        connectedCalls: campCalls.filter(isConnectedCall).length,
      };
    });

    res.json({
      totalCalls:     uniqueTotal,
      connectedCalls: connected.length,
      connectRate:    connectRate + '%',
      avgDuration:    `${avgDurMin}:${avgDurSecRem}`,
      avgDurationSec: avgDurSec,
      campaigns:      campaignData,
      // Tells the frontend (and you) how the number was derived.
      countMethod:    mode,
      countWarning:   mode === 'dedup'
        ? 'No first-time signal from CTM — counting unique callers within the window. This OVERCOUNTS repeat callers whose first call predates the window. Enable the "First Time Caller" auto-tag in CTM.'
        : null,
    });

  } catch (err) {
    console.error('CTM error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/debug-calls — raw visibility into what CTM returns ──
app.all('/api/debug-calls', async (req, res) => {
  try {
    const body = { ...req.query, ...req.body };
    const start = body.start || body.dateFrom;
    const end   = body.end   || body.dateTo;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const raw = await fetchCTMCalls(start, end);
    const detection = detectMode(raw);
    const mode = detection.mode;
    const firstTime = firstTimeCallers(raw, mode);

    // How much each filter stage removes — this is where you see the old
    // number's inflation break down.
    const funnel = {
      rawRowsOnTrackedNumbers: raw.length,
      outboundRemoved:         raw.filter(c => inboundState(c) === false).length,
      nonVoiceRemoved:         raw.filter(c => voiceState(c) === false).length,
      directionFieldMissing:   raw.filter(c => inboundState(c) === null).length,
      typeFieldMissing:        raw.filter(c => voiceState(c) === null).length,
      afterInboundVoice:       raw.filter(isInboundVoice).length,
      notFirstTimeRemoved:     raw.filter(isInboundVoice).filter(c => !isFirstTime(c, mode)).length,
      finalFirstTimeCallers:   firstTime.length,
    };

    const oldWayForComparison = new Set(raw.map(callerNumberOf).filter(Boolean)).size;

    const buckets = new Map(CAMPAIGNS.map(c => [c.campaign, []]));
    for (const call of firstTime) {
      const name = campaignOf(call);
      if (name && buckets.has(name)) buckets.get(name).push(call);
    }

    const perCampaign = CAMPAIGNS.map(camp => {
      const campNumberSet = new Set(camp.numbers.map(n => n.replace(/\D/g, '')));
      const campRaw = raw.filter(call => campNumberSet.has(trackedNumberOf(call)));
      return {
        campaign:          camp.campaign,
        rawCalls:          campRaw.length,
        firstTimeCallers:  (buckets.get(camp.campaign) || []).length,
        taggedCalls:       campRaw.filter(hasFirstTimeTag).length,
        outbound:          campRaw.filter(c => inboundState(c) === false).length,
        nonVoice:          campRaw.filter(c => voiceState(c) === false).length,
        sampleTracked:     campRaw.slice(0, 3).map(trackedNumberOf),
        callersReadable:   campRaw.filter(c => !!callerNumberOf(c)).length,
      };
    });

    // Sample call is for FIELD DISCOVERY ONLY — never echo the raw record.
    // CTM returns transcripts, summaries, caller names, addresses and geo on
    // every call; this endpoint is unauthenticated, so only structural /
    // non-identifying fields are exposed.
    const SAFE_SAMPLE_FIELDS = [
      'direction', 'dial_status', 'call_status', 'status', 'excluded',
      'is_new_caller', 'duration', 'talk_time', 'ring_time',
      'tracking_number', 'tracking_label', 'source', 'called_at', 'tag_list',
    ];
    const sample = raw[0] || null;
    const safeSample = sample
      ? Object.fromEntries(SAFE_SAMPLE_FIELDS
          .filter(k => k in sample)
          .map(k => [k, sample[k]]))
      : null;

    res.json({
      window:      { start, end },
      countMethod: mode,
      detection,
      funnel,
      oldWayForComparison,
      perCampaign,
      sampleCallFields: sample ? Object.keys(sample) : [],
      sampleCall: safeSample,
    });
  } catch (err) {
    console.error('debug-calls error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/add-deal — append a row to the Manual Deals sheet ──
app.post('/api/add-deal', async (req, res) => {
  try {
    const SHEETS_API_KEY   = process.env.SHEETS_API_KEY;
    const MANUAL_SHEET_ID  = process.env.MANUAL_DEALS_SHEET_ID;
    if (!SHEETS_API_KEY || !MANUAL_SHEET_ID) {
      return res.status(500).json({ error: 'SHEETS_API_KEY or MANUAL_DEALS_SHEET_ID env var missing' });
    }
    const { date, agent, source, premium, phone } = req.body;
    if (!date || !premium) return res.status(400).json({ error: 'date and premium are required' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${MANUAL_SHEET_ID}/values/Sheet1!A:E:append?valueInputOption=USER_ENTERED&key=${SHEETS_API_KEY}`;
    const payload = { values: [[date, agent || '', source || '', premium, phone || '']] };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error?.message || `Sheets API ${r.status}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('add-deal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pillar proxy listening on ${PORT}`));
