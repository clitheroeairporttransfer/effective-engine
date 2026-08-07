const fetch = require('node-fetch');

module.exports = {
  // payload: booking object from db
  createBooking: async (payload) => {
    if (!process.env.TAXIWEBBOOKER_BASE_URL) return { ok: false, reason: 'not-configured' };
    // This is a best-effort generic POST. TaxiWebBooker API details vary; replace the URL/path and body shape with the actual API when available.
    const url = process.env.TAXIWEBBOOKER_BASE_URL; // expected to be full URL to create booking
    try {
      const body = {
        pickup: payload.pickup,
        dropoff: payload.dropoff,
        passengerName: payload.passengerName,
        passengerPhone: payload.passengerPhone,
        passengers: payload.passengers,
        datetime: payload.datetime,
        notes: payload.notes,
        paymentType: payload.paymentType,
        flight: payload.flight,
        localBookingId: payload.id
      };
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.TAXIWEBBOOKER_API_KEY) headers['Authorization'] = `Bearer ${process.env.TAXIWEBBOOKER_API_KEY}`;
      const resp = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers });
      const text = await resp.text();
      try { const json = JSON.parse(text); return { ok: resp.ok, id: json.id || json.bookingId || null, raw: json }; } catch (e) { return { ok: resp.ok, raw: text }; }
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
};
