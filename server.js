const express = require('express');
const path = require('path');

const app = express();
const PORT = 3001;

// Balikobot API config
const API_BASE = 'https://apiv2.balikobot.cz';
const API_USER = 'top-dentcz';
const API_KEY = '4rYH1VXK';
const AUTH_HEADER = 'Basic ' + Buffer.from(`${API_USER}:${API_KEY}`).toString('base64');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch from Balikobot API
async function fetchBalikobot(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Authorization': AUTH_HEADER,
      'Content-Type': 'application/json',
    },
  });
  return response.json();
}

// GET /api/carriers
app.get('/api/carriers', async (req, res) => {
  try {
    const data = await fetchBalikobot('/info/carriers');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orderview/:carrier - latest order for a carrier
app.get('/api/orderview/:carrier', async (req, res) => {
  try {
    const data = await fetchBalikobot(`/${req.params.carrier}/orderview`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/package/:carrier/:packageId - package detail
app.get('/api/package/:carrier/:packageId', async (req, res) => {
  try {
    const data = await fetchBalikobot(`/${req.params.carrier}/package/${req.params.packageId}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/all-data - aggregated: carriers + orderview + package details
app.get('/api/all-data', async (req, res) => {
  try {
    const carriersData = await fetchBalikobot('/info/carriers');
    const carriers = carriersData.carriers || [];

    // Fetch orderview + overview + services for each carrier in parallel
    const results = await Promise.allSettled(
      carriers.map(async (carrier) => {
        const [orderview, overview, services] = await Promise.allSettled([
          fetchBalikobot(`/${carrier.slug}/orderview`),
          fetchBalikobot(`/${carrier.slug}/overview`),
          fetchBalikobot(`/${carrier.slug}/services`),
        ]);

        const orderData = orderview.status === 'fulfilled' ? orderview.value : null;
        const overviewData = overview.status === 'fulfilled' ? overview.value : null;
        const servicesData = services.status === 'fulfilled' ? services.value : null;

        // If there's an order, fetch package details for each package_id
        let packageDetails = [];
        if (orderData && orderData.status === 200 && orderData.package_ids?.length) {
          const pkgResults = await Promise.allSettled(
            orderData.package_ids.map(pkgId =>
              fetchBalikobot(`/${carrier.slug}/package/${pkgId}`)
            )
          );
          packageDetails = pkgResults
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value);
        }

        return {
          name: carrier.name,
          slug: carrier.slug,
          endpoint: carrier.endpoint,
          order: orderData && orderData.status === 200 ? orderData : null,
          packages: packageDetails,
          overview: overviewData && overviewData.status === 200 ? overviewData : null,
          services: servicesData,
        };
      })
    );

    const enrichedCarriers = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    res.json({
      status: 200,
      total_carriers: enrichedCarriers.length,
      carriers: enrichedCarriers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync Dashboard API ──
const { runSync, testPohodaConnection, loadSyncLog, loadDb } = require('./sync');

// GET /api/sync/log - sync activity log
app.get('/api/sync/log', async (req, res) => {
  try {
    const log = await loadSyncLog();
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/processed - list of processed invoices
app.get('/api/sync/processed', async (req, res) => {
  try {
    const db = await loadDb();
    res.json(db);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/run - run sync manually (optionally with test invoice)
app.post('/api/sync/run', express.json(), async (req, res) => {
  try {
    const testId = req.body?.testOrderId || null;
    // Run in background so the request doesn't time out
    runSync(testId).catch(err => console.error('Sync run error:', err));
    res.json({ status: 'started', testOrderId: testId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/status - test connections to Pohoda, Balikobot, Upgates
app.get('/api/sync/status', async (req, res) => {
  const status = { pohoda: 'unknown', balikobot: 'unknown', upgates: 'unknown' };

  // Test Balikobot
  try {
    const bbRes = await fetch(`${API_BASE}/info/carriers`, {
      headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' },
    });
    status.balikobot = bbRes.ok ? 'ok' : 'error';
  } catch { status.balikobot = 'error'; }

  // Test Pohoda mServer
  try {
    const pohodaUrl = (process.env.POHODA_MSERVER_URL || 'http://localhost:7778/xml').replace(/\/xml$/, '/status');
    const r = await fetch(pohodaUrl, { signal: AbortSignal.timeout(3000) });
    status.pohoda = r.ok ? 'ok' : (r.status === 401 ? 'auth_error' : 'error');
  } catch { status.pohoda = 'unreachable'; }

  // Test Upgates
  try {
    const ugUrl = process.env.UPGATES_URL || 'https://vase-domena.upgates.com/api/v2';
    const ugAuth = 'Basic ' + Buffer.from(`${process.env.UPGATES_USER || ''}:${process.env.UPGATES_SECRET || ''}`).toString('base64');
    const r = await fetch(`${ugUrl}/orders?limit=1`, {
      headers: { Authorization: ugAuth, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    status.upgates = r.ok ? 'ok' : (r.status === 401 ? 'auth_error' : 'error');
  } catch { status.upgates = 'unreachable'; }

  res.json(status);
});

// ── Periodický automatický sync ──
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '15', 10);

function scheduleSync() {
  const intervalMs = SYNC_INTERVAL_MINUTES * 60 * 1000;
  console.log(`⏰ Automatický sync nastaven každých ${SYNC_INTERVAL_MINUTES} minut`);
  setInterval(() => {
    console.log(`⏰ Spouštím plánovaný sync...`);
    runSync().catch(err => console.error('Chyba plánovaného syncu:', err));
  }, intervalMs);
}

app.listen(PORT, () => {
  console.log(`🚀 Top-Dent Sync Server běží na http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
  scheduleSync();
});