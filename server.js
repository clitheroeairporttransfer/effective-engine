require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const NodeCache = require('node-cache');
const http = require('http');

const db = require('./db');
const twb = require('./twb');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(express.json());
app.use(morgan('combined'));

const defaultWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const defaultMax = parseInt(process.env.RATE_LIMIT_MAX, 10) || 100;
const limiter = rateLimit({ windowMs: defaultWindowMs, max: defaultMax, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

const TAXI_BASE = process.env.TAXIWEBBOOKER_BASE_URL;
const TAXI_KEY = process.env.TAXIWEBBOOKER_API_KEY;

const RAW_API_KEYS = process.env.API_KEYS || process.env.API_KEY || '';
const API_KEYS = RAW_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);

function authMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/' || req.path.startsWith('/driver/') || req.path.startsWith('/public')) return next();
  const headerKey = req.header('x-api-key') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!headerKey) return res.status(401).json({ error: 'Unauthorized', details: 'Missing API key' });
  if (API_KEYS.length > 0 && !API_KEYS.includes(headerKey)) return res.status(403).json({ error: 'Forbidden', details: 'Invalid API key' });
  if (API_KEYS.length === 0) console.warn('No API_KEYS configured — admin endpoints are open to anyone with network access');
  return next();
}
app.use(authMiddleware);

const quotesSchema = Joi.object({ pickup: Joi.string().min(1).required(), dropoff: Joi.string().min(1).required(), passengers: Joi.number().integer().min(1).max(20).optional(), datetime: Joi.string().isoDate().optional(), });

const bookingSchema = Joi.object({ pickup: Joi.string().min(1).required(), dropoff: Joi.string().min(1).required(), passengerName: Joi.string().min(1).required(), passengerPhone: Joi.string().min(5).required(), passengers: Joi.number().integer().min(1).max(20).optional(), datetime: Joi.string().isoDate().required(), notes: Joi.string().allow('').optional(), paymentType: Joi.string().optional(), flight: Joi.string().optional(), });

const idSchema = Joi.string().alphanum().min(1).max(200);

const cacheTtlSeconds = parseInt(process.env.CACHE_TTL_SECONDS, 10) || 60;
const cache = new NodeCache({ stdTTL: cacheTtlSeconds, checkperiod: Math.max(10, Math.floor(cacheTtlSeconds / 2)) });

function missingIntegration(res) {
  return res.status(501).json({ error: 'TaxiWebBooker integration not configured. Set TAXIWEBBOOKER_BASE_URL (and optionally TAXIWEBBOOKER_API_KEY).' });
}

async function tryCreateInTWB(booking) {
  if (!TAXI_BASE) return { ok: false, reason: 'not-configured' };
  try {
    const result = await twb.createBooking(booking);
    return result;
  } catch (e) {
    console.error('TWB create error', e);
    return { ok: false, reason: e.message };
  }
}

// serve static public files
app.use('/public', express.static('public'));

// health and root
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.send('Clitheroe Airport Transfer API'));

// POST /bookings - create booking locally and optionally in TaxiWebBooker
app.post('/bookings', async (req, res) => {
  const { error, value } = bookingSchema.validate(req.body, { convert: true, abortEarly: false });
  if (error) return res.status(400).json({ error: 'Invalid body', details: error.details.map(d => d.message) });

  try {
    const booking = await db.createBooking(value);

    // attempt to create in TaxiWebBooker if configured (stubbed by default)
    const twbResult = await tryCreateInTWB(booking);
    if (twbResult && twbResult.ok) {
      await db.updateBookingTwbId(booking.id, twbResult.id);
      await db.updateBookingStatus(booking.id, 'sent');
    } else if (twbResult && twbResult.reason === 'not-configured') {
      // leave as pending
    } else {
      console.warn('TaxiWebBooker error or stubbed:', twbResult);
    }

    // notify connected drivers via socket (offer)
    const offer = db.offerBookingToDrivers(booking);
    io.emit('booking_offered', offer);

    return res.status(201).json({ booking: booking, twb: twbResult });
  } catch (err) {
    console.error('Create booking error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin JSON endpoint to list bookings
app.get('/admin/bookings', async (req, res) => {
  try {
    const list = db.listBookings();
    return res.json(list);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list bookings' });
  }
});

// Admin forward/resend to TaxiWebBooker
app.post('/admin/bookings/:id/forward', async (req, res) => {
  const id = req.params.id;
  try {
    const booking = db.getBooking(id);
    if (!booking) return res.status(404).json({ error: 'Not found' });
    const twbResult = await tryCreateInTWB(booking);
    if (twbResult && twbResult.ok) {
      db.updateBookingTwbId(id, twbResult.id);
      db.updateBookingStatus(id, 'sent');
      return res.json({ ok: true, twb: twbResult });
    }
    return res.status(502).json({ ok: false, twb: twbResult });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to forward' });
  }
});

// Driver endpoints
app.get('/driver/:token/jobs', (req, res) => {
  const token = req.params.token;
  const driver = db.getDriverByToken(token);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  const jobs = db.listDriverJobs(driver.id);
  return res.json({ driver, jobs });
});

app.post('/driver/:token/jobs/:id/:action', (req, res) => {
  const token = req.params.token;
  const action = req.params.action; // accept|reject|arrive|complete
  const bookingId = req.params.id;
  const driver = db.getDriverByToken(token);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  const booking = db.getBooking(bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  try {
    if (action === 'accept') {
      db.assignBookingToDriver(bookingId, driver.id);
      db.updateBookingStatus(bookingId, 'accepted');
      io.emit('booking_accepted', { bookingId, driverId: driver.id });
      return res.json({ ok: true });
    }
    if (action === 'reject') {
      db.recordDriverRejection(bookingId, driver.id);
      db.updateBookingStatus(bookingId, 'rejected');
      io.emit('booking_rejected', { bookingId, driverId: driver.id });
      return res.json({ ok: true });
    }
    if (action === 'arrive') {
      db.updateBookingStatus(bookingId, 'arrived');
      io.emit('booking_arrived', { bookingId, driverId: driver.id });
      return res.json({ ok: true });
    }
    if (action === 'complete') {
      db.updateBookingStatus(bookingId, 'completed');
      io.emit('booking_completed', { bookingId, driverId: driver.id });
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Action failed' });
  }
});

// serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(require('path').resolve(__dirname, 'public', 'admin.html'));
});

// serve driver page
app.get('/driver/:token', (req, res) => {
  res.sendFile(require('path').resolve(__dirname, 'public', 'driver.html'));
});

// central error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// create http server and attach socket.io
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.on('register_driver', (data) => {
    console.log('driver register', data);
    // no-op for now; we could map socket id to driver token
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (!TAXI_BASE) console.log('Warning: TAXIWEBBOOKER_BASE_URL not set; proxy endpoints will not call TaxiWebBooker until configured.');
  if (API_KEYS.length === 0) console.log('Warning: No API keys configured; admin endpoints are open to any caller unless protected by network rules.');
});
