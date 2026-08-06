require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

const TAXI_BASE = process.env.TAXIWEBBOOKER_BASE_URL; // e.g. https://portal.taxiwebbooker.com/api
const TAXI_KEY = process.env.TAXIWEBBOOKER_API_KEY; // optional API key/token

function missingIntegration(res) {
  return res.status(501).json({ error: 'TaxiWebBooker integration not configured. Set TAXIWEBBOOKER_BASE_URL (and optionally TAXIWEBBOOKER_API_KEY).' });
}

async function forwardRequest(req, res, targetPath) {
  if (!TAXI_BASE) return missingIntegration(res);

  try {
    const url = new URL(targetPath, TAXI_BASE);
    // preserve query params for GET requests
    if (req.method === 'GET' && req.query) {
      Object.entries(req.query).forEach(([k, v]) => {
        if (v !== undefined) url.searchParams.append(k, v);
      });
    }

    const headers = {};
    // forward content-type for JSON bodies
    if (req.is('application/json')) headers['Content-Type'] = 'application/json';
    if (TAXI_KEY) headers['Authorization'] = `Bearer ${TAXI_KEY}`;

    const init = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.body) {
      init.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url.toString(), init);
    const text = await upstream.text();

    // copy selected headers from upstream response (content-type)
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    res.status(upstream.status);
    try {
      // try to return JSON parsed body
      const json = JSON.parse(text);
      return res.json(json);
    } catch (e) {
      return res.send(text);
    }
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
}

// Health and root
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.send('Clitheroe Airport Transfer API'));

// Quotes (example: GET /quotes?pickup=...&dropoff=...)
app.get('/quotes', async (req, res) => {
  return forwardRequest(req, res, '/quotes');
});

// Bookings
app.post('/bookings', async (req, res) => {
  return forwardRequest(req, res, '/bookings');
});
app.get('/bookings/:id', async (req, res) => {
  return forwardRequest(req, res, `/bookings/${encodeURIComponent(req.params.id)}`);
});

// Drivers (list)
app.get('/drivers', async (req, res) => {
  return forwardRequest(req, res, '/drivers');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (!TAXI_BASE) console.log('Warning: TAXIWEBBOOKER_BASE_URL not set; proxy endpoints will return 501 until configured.');
});
