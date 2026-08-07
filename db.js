const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.SQLITE_PATH || path.resolve(__dirname, 'data', 'bookings.db');
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);

// drivers table
db.prepare(`CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  token TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`).run();

// bookings table
db.prepare(`CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  pickup TEXT,
  dropoff TEXT,
  passengerName TEXT,
  passengerPhone TEXT,
  passengers INTEGER,
  datetime TEXT,
  notes TEXT,
  paymentType TEXT,
  flight TEXT,
  status TEXT DEFAULT 'pending',
  twb_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`).run();

// assignments / offers
db.prepare(`CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT,
  driver_id TEXT,
  offered_at INTEGER,
  accepted_at INTEGER,
  rejected_at INTEGER,
  completed_at INTEGER
)`).run();

const uuid = require('crypto').randomUUID;

module.exports = {
  createDriver: (name, phone, token) => {
    const id = uuid();
    const stmt = db.prepare('INSERT INTO drivers (id,name,phone,token) VALUES (?,?,?,?)');
    stmt.run(id, name, phone, token);
    return { id, name, phone, token };
  },
  getDriverByToken: (token) => {
    if (!token) return null;
    return db.prepare('SELECT * FROM drivers WHERE token = ?').get(token);
  },
  createBooking: (payload) => {
    const id = uuid();
    const stmt = db.prepare('INSERT INTO bookings (id,pickup,dropoff,passengerName,passengerPhone,passengers,datetime,notes,paymentType,flight) VALUES (?,?,?,?,?,?,?,?,?,?)');
    stmt.run(id, payload.pickup, payload.dropoff, payload.passengerName, payload.passengerPhone, payload.passengers || null, payload.datetime, payload.notes || '', payload.paymentType || '', payload.flight || '');
    return module.exports.getBooking(id);
  },
  getBooking: (id) => {
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  },
  listBookings: () => {
    return db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 200').all();
  },
  updateBookingTwbId: (id, twbId) => {
    db.prepare('UPDATE bookings SET twb_id = ? WHERE id = ?').run(twbId, id);
  },
  updateBookingStatus: (id, status) => {
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, id);
  },
  offerBookingToDrivers: (booking) => {
    // naive: create an assignment row for audit; no driver selected yet
    const offered_at = Math.floor(Date.now() / 1000);
    const stmt = db.prepare('INSERT INTO assignments (booking_id,offered_at) VALUES (?,?)');
    const info = stmt.run(booking.id, offered_at);
    return { bookingId: booking.id, offered_at };
  },
  assignBookingToDriver: (bookingId, driverId) => {
    const accepted_at = Math.floor(Date.now() / 1000);
    const stmt = db.prepare('UPDATE assignments SET driver_id = ?, accepted_at = ? WHERE booking_id = ?');
    const info = stmt.run(driverId, accepted_at, bookingId);
    // if no existing assignment row, create one
    if (info.changes === 0) {
      db.prepare('INSERT INTO assignments (booking_id,driver_id,accepted_at) VALUES (?,?,?)').run(bookingId, driverId, accepted_at);
    }
  },
  recordDriverRejection: (bookingId, driverId) => {
    const rejected_at = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE assignments SET driver_id = ?, rejected_at = ? WHERE booking_id = ?').run(driverId, rejected_at, bookingId);
  },
  listDriverJobs: (driverId) => {
    // show pending or assigned bookings
    return db.prepare(`SELECT b.* FROM bookings b LEFT JOIN assignments a ON a.booking_id = b.id WHERE (b.status IN ('pending','sent','accepted') AND (a.driver_id IS NULL OR a.driver_id = ?)) ORDER BY b.created_at DESC`).all(driverId);
  }
};
