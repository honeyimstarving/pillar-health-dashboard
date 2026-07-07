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
  { campaign: 'CaPillar Cobra',    numbers: ['+18777136513', '+18889835332'] },
  { campaign: 'Pillar x AA Ruby',  numbers: ['+14245491282'], costPerCall: 30 },
  { campaign: 'CaPillar Emerald',  numbers: ['+18886399178', '+18778651763'] },
  { campaign: 'Gen Health PMAX',   numbers: ['+18777028985', '+18887992605'] },
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
// Sends the date window under several parameter names CTM's calls endpoint is
// known to accept across versions, so a single wrong key can't silently return a
// default (recent-only) window and undercount the day.
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
      // Multiple accepted spellings of the date window:
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

    const total = data.total_count || data.total || 0;
    if (allCalls.length >= total || calls.length < perPage) break;
    page++;
    if (page > 50) break;
  }

  // Filter to only our tracked numbers
  const targetSet = new Set(ALL_NUMBERS.map(n => n.replace(/\D/g, '')));
  return allCalls.filter(call => {
    const calledNum = trackedNumberOf(call);
    return targetSet.has(calledNum);
  });
}

// ── Helpers ──────────────────────────────────────────
// The tracking number the call came in on (digits only).
function trackedNumberOf(call) {
  return String(call.tracking_number || call.tracking_phone_number || call.receiving_number || '').replace(/\D/g, '');
}

// The caller's own number (digits only) — used to dedup to "globally unique".
function callerNumberOf(call) {
  return String(call.caller_number || call.caller_number_e164 || call.caller || call.from_number || call.from || '').replace(/\D/g, '');
}

// Does CTM's own "first time caller" tag appear on this call?
function hasFirstTimeTag(call) {
  const tags = call.tags || call.tag_list || call.labels || '';
  const tagStr = Array.isArray(tags) ? tags.join('|') : String(tags);
  return tagStr.toLowerCase().includes('first time caller');
}

function isConnectedCall(call) {
  return call.answered === true || call.answered === 'true' ||
         call.connected === true || call.status === 'answered';
}

// Count "globally unique" callers within a set of calls: one per distinct caller
// number. This mirrors CTM's Globally Unique column. Calls with no readable
// caller number fall back to the tag so they aren't silently dropped.
function uniqueCallerCount(calls) {
  const seen = new Set();
  let taggedNoNumber = 0;
  for (const call of calls) {
    const caller = callerNumberOf(call);
    if (caller) {
      seen.add(caller);
    } else if (hasFirstTimeTag(call)) {
      taggedNoNumber++;
    }
  }
  return seen.size + taggedNoNumber;
}

// Connected subset, deduped the same way.
function uniqueConnectedCount(calls) {
  const seen = new Set();
  for (const call of calls) {
    if (!isConnectedCall(call)) continue;
    const caller = callerNumberOf(call);
    if (caller) seen.add(caller);
  }
  return seen.size;
}

// ── /api/calls endpoint ──────────────────────────────
app.all('/api/calls', async (req, res) => {
  try {
    const body = { ...req.query, ...req.body };
    const start = body.start || body.dateFrom;
    const end   = body.end   || body.dateTo;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const calls = await fetchCTMCalls(start, end);

    const uniqueTotal     = uniqueCallerCount(calls);
    const uniqueConnected = uniqueConnectedCount(calls);
    const connectRate     = uniqueTotal > 0 ? ((uniqueConnected / uniqueTotal) * 100).toFixed(1) : '0.0';

    let totalDurationSec = 0;
    for (const call of calls) {
      totalDurationSec += parseInt(call.duration_in_seconds || call.duration || 0);
    }
    const avgDurSec    = calls.length > 0 ? Math.round(totalDurationSec / calls.length) : 0;
    const avgDurMin    = Math.floor(avgDurSec / 60);
    const avgDurSecRem = String(avgDurSec % 60).padStart(2, '0');

    // Per-campaign breakdown — unique callers per campaign.
    const campaignData = CAMPAIGNS.map(camp => {
      const campNumberSet = new Set(camp.numbers.map(n => n.replace(/\D/g, '')));
      const campCalls = calls.filter(call => campNumberSet.has(trackedNumberOf(call)));

      const campUnique = uniqueCallerCount(campCalls);
      const result = {
        campaign:       camp.campaign,
        totalCalls:     campUnique,
        connectedCalls: uniqueConnectedCount(campCalls),
      };
      // Flat-rate campaigns (e.g. Pillar x AA Ruby: $30 per first-time caller)
      // have no Google Ads spend — cost is derived from unique call volume instead.
      if (camp.costPerCall) {
        result.spend = +(campUnique * camp.costPerCall).toFixed(2);
        result.costPerCall = camp.costPerCall;
      }
      return result;
    });

    res.json({
      totalCalls:     uniqueTotal,
      connectedCalls: uniqueConnected,
      connectRate:    connectRate + '%',
      avgDuration:    `${avgDurMin}:${avgDurSecRem}`,
      avgDurationSec: avgDurSec,
      campaigns:      campaignData,
    });

  } catch (err) {
    console.error('CTM error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/debug-calls — raw visibility into what CTM returns ──
// Shows the total CTM returned, how many matched our numbers, per-campaign
// unique/tag/raw counts, and a sample of field names so we can see exactly
// which fields carry the caller number and tags.
app.all('/api/debug-calls', async (req, res) => {
  try {
    const body = { ...req.query, ...req.body };
    const start = body.start || body.dateFrom;
    const end   = body.end   || body.dateTo;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const calls = await fetchCTMCalls(start, end);

    const perCampaign = CAMPAIGNS.map(camp => {
      const campNumberSet = new Set(camp.numbers.map(n => n.replace(/\D/g, '')));
      const campCalls = calls.filter(call => campNumberSet.has(trackedNumberOf(call)));
      return {
        campaign:      camp.campaign,
        rawCalls:      campCalls.length,
        uniqueCallers: uniqueCallerCount(campCalls),
        taggedCalls:   campCalls.filter(hasFirstTimeTag).length,
        sampleTracked: campCalls.slice(0, 3).map(trackedNumberOf),
        sampleCallers: campCalls.slice(0, 3).map(callerNumberOf),
      };
    });

    const sample = calls[0] || null;
    res.json({
      window:        { start, end },
      totalReturned: calls.length,
      perCampaign,
      sampleCallFields: sample ? Object.keys(sample) : [],
      sampleCall: sample,
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
