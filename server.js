require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(express.json());
app.use(morgan('combined'));

// Rate limiting (default, can be tuned via env)
const defaultWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000; // 1 minute
const defaultMax = parseInt(process.env.RATE_LIMIT_MAX, 10) || 100; // max requests per window per IP
const limiter = rateLimit({ windowMs: defaultWindowMs, max: defaultMax, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// TaxiWebBooker integration config
const TAXI_BASE = process.env.TAXIWEBBOOKER_BASE_URL; // e.g. https://portal.taxiwebbooker.com/api
const TAXI_KEY = process.env.TAXIWEBBOOKER_API_KEY; // optional API key/token

// API key auth for our proxy API
const RAW_API_KEYS = process.env.API_KEYS || process.env.API_KEY || '';
const API_KEYS = RAW_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);

function authMiddleware(req, res, next) {
  // Allow health and root without auth
  if (req.path === '/health' || req.path === '/') return next();

  const headerKey = req.header('x-api-key') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!headerKey) return res.status(401).json({ error: 'Unauthorized', details: 'Missing API key' });
  if (API_KEYS.length > 0 && !API_KEYS.includes(headerKey)) return res.status(403).json({ error: 'Forbidden', details: 'Invalid API key' });
  // If no API keys are configured, allow through but log a warning
  if (API_KEYS.length === 0) console.warn('No API_KEYS configured — proxy endpoints are open to anyone with network access');
  return next();
}
app.use(authMiddleware);

// Validation schemas
const quotesSchema = Joi.object({
  pickup: Joi.string().min(1).required(),
  dropoff: Joi.string().min(1).required(),
  passengers: Joi.number().integer().min(1).max(20).optional(),
  datetime: Joi.string().isoDate().optional(),
});

const bookingSchema = Joi.object({
  pickup: Joi.string().min(1).required(),
  dropoff: Joi.string().min(1).required(),
  passengerName: Joi.string().min(1).required(),
  passengerPhone: Joi.string().min(5).required(),
  passengers: Joi.number().integer().min(1).max(20).optional(),
  datetime: Joi.string().isoDate().required(),
  notes: Joi.string().allow('').optional(),
});

const idSchema = Joi.string().alphanum().min(1).max(200);

// Simple in-memory cache for quotes
const cacheTtlSeconds = parseInt(process.env.CACHE_TTL_SECONDS, 10) || 60; // default 60s
const cache = new NodeCache({ stdTTL: cacheTtlSeconds, checkperiod: Math.max(10, Math.floor(cacheTtlSeconds / 2)) });

function missingIntegration(res) {
  return res.status(501).json({ error: 'TaxiWebBooker integration not configured. Set TAXIWEBBOOKER_BASE_URL (and optionally TAXIWEBBOOKER_API_KEY).' });
}

async function forwardRequest(req, res, targetPath) {
  if (!TAXI_BASE) return missingIntegration(res);

  // For /quotes GET we validate and use cache
  if (req.method === 'GET' && targetPath.startsWith('/quotes')) {
    // validate query
    const { error, value } = quotesSchema.validate(req.query, { convert: true, abortEarly: false });
    if (error) return res.status(400).json({ error: 'Invalid query', details: error.details.map(d => d.message) });

    // cache key
    const cacheKey = `quotes:${JSON.stringify(value)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ cached: true, data: cached });
    }
  }

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

    // handle upstream status codes
    if (upstream.status >= 500) {
      console.error('Upstream error', upstream.status, text);
      return res.status(502).json({ error: 'Upstream service error', status: upstream.status });
    }

    if (upstream.status >= 400) {
      // pass through client errors with body if possible
      try {
        const jsonErr = JSON.parse(text);
        return res.status(upstream.status).json({ error: 'Upstream error', details: jsonErr });
      } catch (e) {
        return res.status(upstream.status).json({ error: 'Upstream error', details: text });
      }
    }

    // success: cache quotes responses
    if (req.method === 'GET' && targetPath.startsWith('/quotes')) {
      try {
        const json = JSON.parse(text);
        const cacheKey = `quotes:${JSON.stringify(req.query)}`;
        cache.set(cacheKey, json, cacheTtlSeconds);
        return res.json({ cached: false, data: json });
      } catch (e) {
        return res.send(text);
      }
    }

    // default success path
    try {
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
  // validate body
  const { error, value } = bookingSchema.validate(req.body, { convert: true, abortEarly: false });
  if (error) return res.status(400).json({ error: 'Invalid body', details: error.details.map(d => d.message) });
  // forward validated body
  req.body = value;
  return forwardRequest(req, res, '/bookings');
});
app.get('/bookings/:id', async (req, res) => {
  const { error } = idSchema.validate(req.params.id);
  if (error) return res.status(400).json({ error: 'Invalid id', details: error.details.map(d => d.message) });
  return forwardRequest(req, res, `/bookings/${encodeURIComponent(req.params.id)}`);
});

// Drivers (list)
app.get('/drivers', async (req, res) => {
  return forwardRequest(req, res, '/drivers');
});

// Central error handler (fallback)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (!TAXI_BASE) console.log('Warning: TAXIWEBBOOKER_BASE_URL not set; proxy endpoints will return 501 until configured.');
  if (API_KEYS.length === 0) console.log('Warning: No API keys configured; API endpoints are open to any caller unless protected by network rules.');
});
