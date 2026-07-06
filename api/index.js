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
  { campaign: 'Pillar x AA Ruby',     numbers: ['+14245491282'], costPerCall: 30 },
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
    const calledNum = (call.tracking_number || call.tracking_phone_number || '').replace(/\D/g, '');
    return targetSet.has(calledNum);
  });
}

// ── /api/calls endpoint ──────────────────────────────
app.all('/api/calls', async (req, res) => {
  try {
    const body = { ...req.query, ...req.body };
    const start = body.start || body.dateFrom;
    const end   = body.end   || body.dateTo;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const calls = await fetchCTMCalls(start, end);

    // ── COUNT BY "first time caller" TAG ──
    const isFirstTimeCaller = (call) => {
      const tags = call.tags || call.tag_list || call.labels || '';
      const tagStr = Array.isArray(tags) ? tags.join('|') : String(tags);
      return tagStr.toLowerCase().includes('first time caller');
    };

    const isConnectedCall = (call) =>
      call.answered === true   ||
      call.answered === 'true' ||
      call.connected === true  ||
      call.status === 'answered';

    const firstTimeCalls  = calls.filter(isFirstTimeCaller);
    const uniqueTotal     = firstTimeCalls.length;
    const uniqueConnected = firstTimeCalls.filter(isConnectedCall).length;
    const connectRate     = uniqueTotal > 0 ? ((uniqueConnected / uniqueTotal) * 100).toFixed(1) : '0.0';

    let totalDurationSec = 0;
    for (const call of calls) {
      totalDurationSec += parseInt(call.duration_in_seconds || call.duration || 0);
    }
    const avgDurSec    = calls.length > 0 ? Math.round(totalDurationSec / calls.length) : 0;
    const avgDurMin    = Math.floor(avgDurSec / 60);
    const avgDurSecRem = String(avgDurSec % 60).padStart(2, '0');

    // Per-campaign breakdown (also deduped per campaign)
    const campaignData = CAMPAIGNS.map(camp => {
      const campNumberSet = new Set(camp.numbers.map(n => n.replace(/\D/g, '')));
      const campCalls = calls.filter(call => {
        const tracked = (call.tracking_number || call.tracking_phone_number || '').replace(/\D/g, '');
        return campNumberSet.has(tracked);
      });

      const campFirstTime = campCalls.filter(isFirstTimeCaller);
      const result = {
        campaign:       camp.campaign,
        totalCalls:     campFirstTime.length,
        connectedCalls: campFirstTime.filter(isConnectedCall).length,
      };
      // Flat-rate campaigns (e.g. Pillar x AA Ruby: $30 per first-time caller)
      // have no Google Ads spend — cost is derived from call volume instead.
      if (camp.costPerCall) {
        result.spend = +(campFirstTime.length * camp.costPerCall).toFixed(2);
        result.costPerCall = camp.costPerCall;
      }
      return result;
    });

    res.json({
      totalCalls:     uniqueTotal,
      connectedCalls: uniqueConnected,
      connectRate:    connectRate + '%',
      avgDuration:    `${avgDurMin}:${avgDurSecRem}`,
      campaigns:      campaignData,
    });

  } catch (err) {
    console.error('CTM error:', err.message);
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
