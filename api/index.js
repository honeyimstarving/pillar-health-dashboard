const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const app     = express();
app.use(cors());
app.use(express.json());

// ── CTM CREDENTIALS (set these as Railway env vars) ──
const CTM_API_KEY    = process.env.CTM_API_KEY;    // your CTM API key
const CTM_ACCOUNT_ID = process.env.CTM_ACCOUNT_ID; // your CTM account ID (numeric)

// ── CAMPAIGN CONFIG ──────────────────────────────────
// Each entry: { campaign, numbers: ['+1XXXXXXXXXX', ...] }
const CAMPAIGNS = [
  {
    campaign: 'CaPillar Cobra',
    numbers:  ['+18777136513'],  // (877) 713-6513
  },
  {
    campaign: 'CaPillar Cobra LP',
    numbers:  ['+18889835332'],  // (888) 983-5332
  },
];

const ALL_NUMBERS = CAMPAIGNS.flatMap(c => c.numbers);

// ── CTM call log fetch ───────────────────────────────
// CTM REST API: GET /api/v1/{account_id}/calls
// Docs: https://app.calltrackingmetrics.com/api
async function fetchCTMCalls(dateFrom, dateTo, numbers) {
  if (!CTM_API_KEY || !CTM_ACCOUNT_ID) {
    throw new Error('CTM_API_KEY and CTM_ACCOUNT_ID env vars are required');
  }

  const allCalls = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const params = new URLSearchParams({
      page:       String(page),
      per_page:   String(perPage),
      start_date: dateFrom,   // YYYY-MM-DD
      end_date:   dateTo,     // YYYY-MM-DD
    });

    const url = `https://app.calltrackingmetrics.com/api/v1/accounts/${CTM_ACCOUNT_ID}/calls?${params}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${CTM_API_KEY}:`).toString('base64'),
        'Content-Type':  'application/json',
      }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CTM API ${res.status}: ${body}`);
    }

    const data = await res.json();
    const calls = data.calls || data.data || [];
    allCalls.push(...calls);

    // Paginate until we've got all pages
    const total = data.total_count || data.total || 0;
    if (allCalls.length >= total || calls.length < perPage) break;
    page++;
    if (page > 50) break; // safety cap
  }

  // Filter to only our tracked numbers if provided
  const targetSet = new Set((numbers || ALL_NUMBERS).map(n => n.replace(/\D/g,'')));
  const relevant = targetSet.size > 0
    ? allCalls.filter(c => {
        const called = (c.tracking_number || c.called_number || '').replace(/\D/g,'');
        return targetSet.has(called);
      })
    : allCalls;

  return relevant;
}

// ── /api/calls ───────────────────────────────────────
app.post('/api/calls', async (req, res) => {
  const { dateFrom, dateTo } = req.body || {};
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo required' });
  }

  try {
    const calls = await fetchCTMCalls(dateFrom, dateTo, ALL_NUMBERS);

    // CTM: answered = call.status === 'answered' or duration > 0
    const isConnected = c =>
      c.status === 'answered' ||
      (c.duration && parseInt(c.duration) > 0);

    const totalCalls     = calls.length;
    const connectedCalls = calls.filter(isConnected).length;
    const durations      = calls.filter(isConnected).map(c => parseInt(c.duration) || 0);
    const avgDurationSec = durations.length > 0
      ? Math.round(durations.reduce((a,b)=>a+b,0) / durations.length)
      : 0;

    // Per-campaign breakdown
    const campaigns = CAMPAIGNS.map(camp => {
      const numSet  = new Set(camp.numbers.map(n => n.replace(/\D/g,'')));
      const subset  = calls.filter(c => {
        const called = (c.tracking_number || c.called_number || '').replace(/\D/g,'');
        return numSet.has(called);
      });
      const connected = subset.filter(isConnected).length;
      return {
        campaign:      camp.campaign,
        totalCalls:    subset.length,
        connectedCalls: connected,
      };
    });

    res.json({ totalCalls, connectedCalls, avgDurationSec, campaigns });
  } catch (err) {
    console.error('CTM error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pillar Health proxy on port ${PORT}`));
