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

app.listen(PORT, () => {
  console.log(`🚀 Balikobot Data Viewer running at http://localhost:${PORT}`);
});