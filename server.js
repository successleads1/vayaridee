// server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import morgan from 'morgan';
import session from 'express-session';
import bcrypt from 'bcrypt';

/* ---- Auth & Routers ---- */
import passport from './src/auth/passport.js';
import driverAuthRouter from './src/routes/driverAuth.js';
import adminRouter from './src/routes/admin.js';

/* ---- Models ---- */
import Ride from './src/models/Ride.js';
import Driver from './src/models/Driver.js';
import Rider from './src/models/Rider.js';
import Admin from './src/models/Admin.js';
import Activity from './src/models/Activity.js';

import payfastNotifyRouter from './src/routes/payfastNotify.js';
import partnerRouter from './src/routes/partner.js';
/* ---- Bots ---- */
import { initRiderBot, riderEvents, riderBot as RB } from './src/bots/riderBot.js';
import { initDriverBot, driverEvents, driverBot as DB, notifyDriverRideFinished } from './src/bots/driverBot.js';

// import { notifyDriverRideFinished } from './src/bots/driverBot.js';
import {
  initWhatsappBot,
  waitForQrDataUrl,
  isWhatsAppConnected,
  getConnectionStatus,
  sendWhatsAppMessage,
  resetWhatsAppSession,
} from './src/bots/whatsappBot.js';

/* ---- Services ---- */
import { assignNearestDriver, setEstimateOnRide, hasNumericChatId } from './src/services/assignment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });
app.set('io', io);

const PORT = process.env.PORT || 3000;
const TRACK_LINK_TTL_HOURS = Number(process.env.TRACK_LINK_TTL_HOURS || 24);

/* ---------------- Mongo ---------------- */
await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ MongoDB connected');

/* ---------------- Init Bots ---------------- */
initWhatsappBot();
const riderBot = initRiderBot(io);
const driverBot = initDriverBot(io);
console.log('🤖 Rider bot initialized');
console.log('🚗 Driver bot initialized');

/* ---------------- App setup ---------------- */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public'))); // serves /wa-qr.png and /track.html
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// after app.use(express.urlencoded({ extended: true }))
app.use('/api/payfast', payfastNotifyRouter);
app.use('/api/partner', partnerRouter);   // ← this path must match your redirect


app.use(
  session({
    secret: process.env.SESSION_SECRET || 'devsecret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 12 * 60 * 60 * 1000 },
  })
);
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => { res.locals.user = req.user || null; next(); });

/* ---------------- Seed Admin (optional) ---------------- */
async function ensureSeedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('⚠️ Skipping admin seed: ADMIN_EMAIL/ADMIN_PASSWORD not set');
    return;
  }
  const existing = await Admin.findOne({ email: ADMIN_EMAIL });
  if (existing) return;
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await Admin.create({
    name: ADMIN_NAME || 'Super Admin',
    email: ADMIN_EMAIL,
    passwordHash
  });
  console.log('🛡️ Seeded admin:', ADMIN_EMAIL);
}
await ensureSeedAdmin();

/* ---------------- Helper: log + broadcast to admin ---------------- */
async function logActivity({
  rideId,
  type,
  message,
  actorType = 'system',
  actorId = null,
  meta = {}
}) {
  try {
    const a = await Activity.create({ rideId, type, message, actorType, actorId, meta });
    io.emit('admin:activity', {
      _id: String(a._id),
      rideId: String(rideId),
      type,
      message,
      actorType,
      actorId,
      createdAt: a.createdAt,
      meta
    });
  } catch (e) {
    console.warn('logActivity failed:', e?.message || e);
  }
}

/* ---------------- Routes ---------------- */
app.get('/', (req, res) => res.render('landing', { title: 'VayaRide' }));
app.use('/driver', driverAuthRouter);
app.use('/admin', adminRouter);

app.get('/api/rider-by-token/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const pin = req.query.pin;
    const rider = await Rider.findOne({ dashboardToken: token });
    if (!rider) return res.status(404).json({ error: 'Rider not found' });

    const now = new Date();
    if (
      !rider.dashboardTokenExpiry ||
      rider.dashboardPin !== pin ||
      now > new Date(rider.dashboardTokenExpiry)
    ) {
      return res.status(401).json({ error: 'Access denied. PIN or token expired' });
    }

    // Robust id matching (covers legacy string vs number)
    const idNum = Number(rider.chatId);
    const idStr = String(rider.chatId);

    // Do both queries in parallel
    const [lastPaid, tripsCompleted] = await Promise.all([
      // Last payment/ride (tolerant: either explicitly paid, or completed)
      Ride.findOne({
        riderChatId: { $in: [idNum, idStr] },
        $or: [{ paymentStatus: 'paid' }, { status: 'completed' }]
      })
        // Prefer paidAt, else completedAt, else updatedAt, else createdAt
        .sort({
          paidAt: -1,
          completedAt: -1,
          updatedAt: -1,
          createdAt: -1
        })
        .lean(),

      // Source of truth for Trips Completed
      Ride.countDocuments({
        riderChatId: { $in: [idNum, idStr] },
        status: 'completed'
      })
    ]);

    const lastPayment = lastPaid
      ? {
          rideId: String(lastPaid._id),
          amount: Number(lastPaid.finalAmount ?? lastPaid.estimate ?? 0) || 0,
          method: lastPaid.paymentMethod || null, // 'cash' | 'payfast'
          at:
            lastPaid.paidAt ||
            lastPaid.completedAt ||
            lastPaid.updatedAt ||
            lastPaid.createdAt ||
            null
        }
      : null;

    // Disable caching so the dashboard always gets fresh data
    res.set('Cache-Control', 'no-store');

    return res.json({
      chatId: rider.chatId,
      name: rider.name,
      email: rider.email,
      credit: rider.credit,
      trips: tripsCompleted,  // ✅ live count
      lastPayment
    });
  } catch (e) {
    console.error('rider-by-token error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});


/* WhatsApp QR Code helpers */
app.post('/wa/reset', async (req, res) => {
  await resetWhatsAppSession();
  res.json({ ok: true, message: 'WhatsApp session reset. Open /qrcode to scan again.' });
});

app.get('/qrcode', async (req, res) => {
  if (isWhatsAppConnected()) {
    return res.send('<h2>✅ WhatsApp is connected.</h2>');
  }
  try {
    const dataUrl = await waitForQrDataUrl(25000);
    res.send(`<div style="font-family:system-ui;display:grid;place-items:center;gap:12px">
      <h3>Scan to connect WhatsApp</h3>
      <img src="${dataUrl}" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #eee;border-radius:12px" />
      <p>If it stalls, refresh or try <code>/wa/reset</code>.</p>
    </div>`);
  } catch {
    const pngPath = path.join(__dirname, 'public/wa-qr.png');
    const fallback = fs.existsSync(pngPath)
      ? `<img src="/wa-qr.png" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #eee;border-radius:12px" />`
      : '<em>No QR yet. Try again shortly.</em>';
    res.send(`<div style="font-family:system-ui;display:grid;place-items:center;gap:12px">
      <h3>QR not ready</h3>${fallback}
      <p>Or call <a href="/wa/reset">/wa/reset</a> then refresh.</p>
    </div>`);
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  const status = getConnectionStatus();
  res.json({ status, connected: isWhatsAppConnected() });
});

/* Profile update (dashboard) */
/* Profile update (dashboard) */
app.post('/api/update-profile', async (req, res) => {
  const { chatId, name, email, credit } = req.body;
  if (!chatId || isNaN(Number(chatId))) {
    return res.status(400).send('❌ Invalid or missing chatId.');
  }

  const rider = await Rider.findOne({ chatId: Number(chatId) });
  if (!rider) {
    return res.status(403).send('<h2>❌ Unauthorized: Rider not found</h2>');
  }

  if (name != null) rider.name = name;
  if (email != null) rider.email = email;
  // Only update credit if provided (dashboard no longer sends it)
  if (credit != null && credit !== '') rider.credit = credit;

  await rider.save();
  res.send('<h2>✅ Profile updated securely.</h2>');
});

/* Legacy rider endpoint */
app.get('/api/rider/:chatId', async (req, res) => {
  const rider = await Rider.findOne({ chatId: req.params.chatId });
  if (!rider) return res.status(404).json({ error: 'Rider not found' });

  res.json({
    name: rider.name,
    email: rider.email,
    credit: rider.credit,
    trips: rider.trips || 0
  });
});

/* Webhook endpoints (optional; safe if using polling) */
app.post('/rider-bot', (req, res) => {
  riderBot.processUpdate?.(req.body);
  res.sendStatus(200);
});
app.post('/driver-bot', (req, res) => {
  driverBot.processUpdate?.(req.body);
  res.sendStatus(200);
});

/* Pay route */
app.use('/pay', (await import('./src/routes/payfast.js')).default);

/* Map/track page (back-compat) */
app.get('/map/:rideId', (req, res) => {
  const url = `/track.html?rideId=${encodeURIComponent(req.params.rideId)}`;
  res.redirect(302, url);
});

/* ---------------- Tracking APIs ---------------- */

function isRideLinkExpired(ride) {
  // terminal states always expire the link
  if (['cancelled', 'completed', 'payment_pending'].includes(ride.status)) {
    return { expired: true, reason: ride.status };
  }
  // TTL expiry for stale links (optional)
  if (TRACK_LINK_TTL_HOURS > 0) {
    const made = new Date(ride.createdAt || Date.now());
    const expiresAt = new Date(made.getTime() + TRACK_LINK_TTL_HOURS * 3600 * 1000);
    if (Date.now() > +expiresAt) {
      return { expired: true, reason: 'ttl', expiresAt };
    }
  }
  return { expired: false, reason: null };
}

app.get('/api/ride/:rideId', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId).lean();
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    // Expiry gate: cancel/completed/ttl
    const exp = isRideLinkExpired(ride);
    if (exp.expired) {
      return res.status(410).json({
        error: 'expired',
        status: ride.status,
        reason: exp.reason,                // 'cancelled' | 'completed' | 'payment_pending' | 'ttl'
        createdAt: ride.createdAt,
        cancelledAt: ride.cancelledAt || null,
        completedAt: ride.completedAt || null,
        expiresAt: exp.expiresAt || null
      });
    }

    // Provide extra fields the client can use to hold state
    let driverChatId = null;
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (drv && typeof drv.chatId === 'number') driverChatId = drv.chatId;
    }

    res.json({
      pickup: ride.pickup,
      destination: ride.destination,
      status: ride.status || 'pending',
      driverChatId,
      pickedAt: ride.pickedAt || ride.startedAt || null,
      completedAt: ride.completedAt || null,
      createdAt: ride.createdAt
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/driver-last-loc/:chatId', async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    if (Number.isNaN(chatId)) return res.status(400).json({});
    const driver = await Driver.findOne({ chatId }).lean();
    if (!driver || !driver.location) {
      console.log(`ℹ️ No last location for driver chatId=${chatId}`);
      return res.json({});
    }
    console.log(`↩️ API last loc chatId=${chatId} lat=${driver.location.lat} lng=${driver.location.lng}`);
    res.json(driver.location);
  } catch {
    res.json({});
  }
});

/* -------- live driver tickers (per driver) -------- */
const lastLocByDriver = new Map();     // chatId -> { lat, lng, ts }
const tickerByDriver = new Map();      // chatId -> intervalId
function stopDriverTicker(chatId) {
  const id = tickerByDriver.get(Number(chatId));
  if (id) {
    clearInterval(id);
    tickerByDriver.delete(Number(chatId));
  }
  lastLocByDriver.delete(Number(chatId));
}

/* ⭐ NEW: in-memory "arrived" dedupe per ride */
const arrivedAnnounced = new Set(); // Set(rideId)

/* ---------------- utilities ---------------- */
function toRad(x){ return (x * Math.PI) / 180; }
function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(Math.max(0, s)));
}

/* ⭐⭐ PATH CAPTURE (driver tracking) — minimal, write-capped */
const lastPathByRide = new Map(); // rideId -> { lat, lng, ts }
async function appendPathPoint(rideId, lat, lng, label = '') {
  try {
    const key = String(rideId);
    const now = Date.now();
    const prev = lastPathByRide.get(key);
    const fastEnough = !prev || (now - prev.ts) >= 2500; // 2.5s min
    const farEnough  = !prev || haversineMeters(prev, { lat, lng }) >= 8; // 8m min

    if (!fastEnough && !farEnough) return;

    await Ride.updateOne(
      { _id: rideId },
      { $push: { path: { lat, lng, ts: new Date() } } }
    );

    lastPathByRide.set(key, { lat, lng, ts: now });

    if (label) {
      console.log(`🧭 PATH ${label} ride=${key} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`);
    }
  } catch (e) {
    // Non-fatal
    console.warn('appendPathPoint failed:', e?.message || e);
  }
}

/* ---------------- Live driver broadcasts (per-driver + per-ride) ---------------- */
driverEvents.on('driver:location', async ({ chatId, location }) => {
  try {
    const cId = Number(chatId);
    const { lat, lng } = location || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') return;

    lastLocByDriver.set(cId, { lat, lng, ts: Date.now() });

    io.emit(`driver:${cId}:location`, { lat, lng });

    // find active ride for this driver
    const drv = await Driver.findOne({ chatId: cId }).select('_id').lean();
    if (drv?._id) {
      const ride = await Ride.findOne({
        driverId: drv._id,
        status: { $in: ['accepted', 'enroute'] }
      }).sort({ updatedAt: -1 }).lean();

      if (ride?._id) {
        // broadcast to ride viewers
        io.emit(`ride:${ride._id}:driverLocation`, { lat, lng });

        // ⭐ also append to the ride path (capped)
        appendPathPoint(ride._id, lat, lng);

        // server-side arrival auto-detect
        if (ride.status === 'accepted' && ride.pickup?.lat && ride.pickup?.lng && !arrivedAnnounced.has(String(ride._id))) {
          const dMeters = haversineMeters({ lat, lng }, ride.pickup);
          if (dMeters <= 35) {
            arrivedAnnounced.add(String(ride._id));
            driverEvents.emit('ride:arrived', { driverId: chatId, rideId: String(ride._id) });
            io.emit(`ride:${ride._id}:arrived`);
          }
        }
      }
    }

    // heartbeat rebroadcast loop
    if (!tickerByDriver.has(cId)) {
      const id = setInterval(async () => {
        const last = lastLocByDriver.get(cId);
        if (!last) return;

        const staleMs = Date.now() - last.ts;
        if (staleMs > 2 * 60 * 1000) {
          stopDriverTicker(cId);
          return;
        }

        io.emit(`driver:${cId}:location`, { lat: last.lat, lng: last.lng });

        try {
          const drv2 = await Driver.findOne({ chatId: cId }).select('_id').lean();
          if (!drv2?._id) return;
          const active = await Ride.findOne({
            driverId: drv2._id,
            status: { $in: ['accepted', 'enroute'] }
          }).sort({ updatedAt: -1 }).select('_id').lean();
          if (active?._id) {
            io.emit(`ride:${active._id}:driverLocation`, { lat: last.lat, lng: last.lng });
          }
        } catch {}
      }, 1000);
      tickerByDriver.set(cId, id);
    }
  } catch (e) {
    console.warn('driver:location broadcast failed:', e?.message || e);
  }
});

/* ---------------- BOOKING DISPATCH PIPELINE ---------------- */
async function dispatchToNearestDriver({ rideId, excludeDriverIds = [] }) {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'pending') return;

  const chosen = await assignNearestDriver(ride.pickup, {
    vehicleType: ride.vehicleType || null,
    exclude: excludeDriverIds
  });

  if (!chosen || !hasNumericChatId(chosen)) {
    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '😕 No drivers are available right now. We will keep trying shortly.'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '😕 No drivers are available right now. We will keep trying shortly.'); } catch {}
    return;
  }

  try { await setEstimateOnRide(ride._id, chosen.location || null); } catch {}

  await logActivity({
    rideId: ride._id,
    type: 'assigned',
    actorType: 'system',
    message: `Assigned to driver ${chosen.name || chosen.email || chosen.chatId || chosen._id}`,
    meta: { driverId: String(chosen._id), driverChatId: chosen.chatId ?? null }
  });

  const toMap = ({ lat, lng }) => `https://maps.google.com/?q=${lat},${lng}`;
  const text =
    `🚗 <b>New Ride Request</b>\n\n` +
    `• Vehicle: <b>${(ride.vehicleType || 'normal').toUpperCase()}</b>\n` +
    (ride.estimate ? `• Estimate: <b>R${ride.estimate}</b>\n` : '') +
    `• Pickup: <a href="${toMap(ride.pickup)}">Open Map</a>\n` +
    `• Drop:   <a href="${toMap(ride.destination || ride.pickup)}">Open Map</a>\n\n` +
    `Accept to proceed.`;

  try {
    await DB.sendMessage(chosen.chatId, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Accept', callback_data: `accept_${ride._id}` },
          { text: '🙈 Ignore', callback_data: `ignore_${ride._id}` }
        ]]
      }
    });
  } catch (e) {
    console.warn('Failed to DM driver request:', e?.message || e);
  }
}

riderEvents.on('booking:new', async ({ rideId }) => {
  try {
    if (!rideId) return;
    await logActivity({ rideId, type: 'request', actorType: 'rider', message: 'Rider requested a trip' });
    await dispatchToNearestDriver({ rideId });
  } catch (e) { console.error('booking:new handler error:', e?.message || e); }
});

driverEvents.on('ride:ignored', async ({ previousDriverId, ride }) => {
  try {
    if (!ride || !ride._id) return;
    await logActivity({
      rideId: ride._id,
      type: 'ignored',
      actorType: 'driver',
      actorId: String(previousDriverId),
      message: `Driver ${previousDriverId} ignored the ride`
    });
    const prevDriver = await Driver.findOne({ chatId: Number(previousDriverId) }).lean();
    const excludeIds = prevDriver ? [prevDriver._id] : [];
    await dispatchToNearestDriver({ rideId: String(ride._id), excludeDriverIds: excludeIds });
  } catch (e) { console.error('ride:ignored handler error:', e?.message || e); }
});

/* ➕ When the driver accepts, send THEM a driver-mode link that streams HTML5 GPS */
driverEvents.on('ride:accepted', async ({ driverId, rideId }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    if (!ride.driverId) {
      const drv = await Driver.findOne({ chatId: Number(driverId) });
      if (drv) { ride.driverId = drv._id; await ride.save(); }
    }

    await logActivity({
      rideId,
      type: 'accepted',
      actorType: 'driver',
      actorId: String(driverId),
      message: `Driver ${driverId} accepted the ride`
    });

    const base = `${process.env.PUBLIC_URL}/track.html?rideId=${encodeURIComponent(rideId)}`;
    const riderLink  = base;
    const driverLink = `${base}&as=driver&driverChatId=${encodeURIComponent(driverId)}`;

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, `🚗 Your ride is on the way. Track here:\n${riderLink}`); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, `🚗 Your ride is on the way. Track here:\n${riderLink}`); } catch {}
    try { await DB.sendMessage(driverId, `🗺️ Open the live trip map (shares your GPS):\n${driverLink}`); } catch {}
  } catch (e) {
    console.warn('ride:accepted handler failed:', e?.message || e);
  }
});

/* ⭐ CHG: when arrived, also emit a socket event so the map modal can show */
driverEvents.on('ride:arrived', async ({ rideId }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    await logActivity({
      rideId,
      type: 'arrived',
      actorType: 'driver',
      message: 'Driver arrived at pickup'
    });

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '📍 Your driver has arrived at the pickup point.'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '📍 Your driver has arrived at the pickup point.'); } catch {}

    io.emit(`ride:${rideId}:arrived`);
  } catch (e) {
    console.warn('ride:arrived handler failed:', e?.message || e);
  }
});

/* ⭐ NEW: picked event (for admin activity feed) */
driverEvents.on('ride:picked', async ({ rideId, by }) => {
  try {
    await logActivity({
      rideId,
      type: 'picked',
      actorType: 'driver',
      message: 'Rider picked up',
      meta: { by: by || 'unknown' }
    });
  } catch (e) {
    console.warn('ride:picked handler failed:', e?.message || e);
  }
});

driverEvents.on('ride:started', async ({ rideId, by }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    arrivedAnnounced.delete(String(rideId));

    await logActivity({
      rideId,
      type: 'started',
      actorType: 'driver',
      message: 'Trip started',
      meta: { by: by || 'unknown' }
    });

    const origin = (by || '').toLowerCase();
    const skipNotify = origin === 'web' || origin === 'driver_bot';
    if (skipNotify) return;

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
  } catch (e) {
    console.warn('ride:started handler failed:', e?.message || e);
  }
});

/* ---------------- Start Trip API (driver clicks Start in map UI) ---------------- */
app.post('/api/ride/:rideId/start', async (req, res) => {
  try {
    const { rideId } = req.params;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    if (!['enroute','completed','cancelled'].includes(ride.status)) {
      ride.status = 'enroute';
      await ride.save();
    }

    const riderChatId =
      ride.riderChatId ||
      ride.riderTelegramChatId ||
      ride.rider?.chatId ||
      null;

    if (riderChatId && riderBot) {
      try {
        await riderBot.sendMessage(
          Number(riderChatId),
          '🚗 Your driver has started the trip and is heading to you.'
        );
      } catch (err) {
        console.error('Failed to message rider on Telegram:', err?.message || err);
      }
    }

    try {
      driverEvents.emit('ride:started', { rideId: ride._id.toString(), by: 'web' });
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/start error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- Picked Up API (driver clicks Picked in map UI) ---------------- */
app.post('/api/ride/:rideId/picked', async (req, res) => {
  try {
    const { rideId } = req.params;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    if (!['enroute','completed','cancelled'].includes(ride.status)) {
      ride.status = 'enroute';
      await ride.save();
    }

    const riderChatId =
      ride.riderChatId ||
      ride.riderTelegramChatId ||
      ride.rider?.chatId ||
      null;

    if (riderChatId && riderBot) {
      try {
        await riderBot.sendMessage(
          Number(riderChatId),
          '✅ You have been picked up. Heading to your destination now.'
        );
      } catch (err) {
        console.error('Failed to message rider on Telegram (picked):', err?.message || err);
      }
    }

    try {
      driverEvents.emit('ride:picked', { rideId: ride._id.toString(), by: 'web' });
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/picked error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---- Minimal fare helpers for finish (same as you had) ---- */
const RATE_TABLE = {
  normal:  { baseFare: 0, perKm: 7,  minCharge: 30, withinKm: 30 },
  comfort: { baseFare: 0, perKm: 8,  minCharge: 30, withinKm: 30 },
  luxury:  { baseFare: 0, perKm: 12, minCharge: 45, withinKm: 45 },
  xl:      { baseFare: 0, perKm: 10, minCharge: 39, withinKm: 40 }
};
function haversineKm(a, b){
  if (!a || !b || typeof a.lat!=='number' || typeof a.lng!=='number' || typeof b.lat!=='number' || typeof b.lng!=='number') return 0;
  const toRad = (x)=> x * Math.PI / 180;
  const R = 6371; // km
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function pathLengthKm(path){
  if (!Array.isArray(path) || path.length < 2) return 0;
  let km = 0;
  for (let i = 1; i < path.length; i++){
    const p0 = path[i-1], p1 = path[i];
    if (!p0 || !p1) continue;
    km += haversineKm({lat:p0.lat, lng:p0.lng}, {lat:p1.lat, lng:p1.lng});
  }
  return km;
}
function expectedDurationSec(distanceKm, avgKph = 30){
  const hours = distanceKm / Math.max(1, avgKph);
  return Math.round(hours * 3600);
}
function priceFromRate(distanceKm, vehicleType='normal'){
  const vt = RATE_TABLE[vehicleType] ? vehicleType : 'normal';
  const rate = RATE_TABLE[vt];
  const d = Math.max(0, Number(distanceKm || 0));
  const within = rate.withinKm ?? 0;
  const variable = d <= within ? 0 : (rate.perKm ?? 0) * (d - within);
  const base = (rate.baseFare ?? 0) + (rate.minCharge ?? 0) + variable;
  return Math.round(base);
}
async function computeFinalFare({
  pickup,
  destination,
  vehicleType = 'normal',
  path = null,
  createdAt = null,
  pickedAt = null,
  completedAt = new Date()
} = {}) {
  let tripKm = 0;
  if (Array.isArray(path) && path.length >= 2) tripKm = pathLengthKm(path);
  else tripKm = haversineKm(pickup, destination) * 1.25;

  const startTs = pickedAt ? new Date(pickedAt).getTime() : (createdAt ? new Date(createdAt).getTime() : Date.now());
  const endTs   = completedAt ? new Date(completedAt).getTime() : Date.now();
  const actualDurationSecVal = Math.max(0, Math.round((endTs - startTs) / 1000));
  const expectedSec = expectedDurationSec(tripKm, 30);

  return {
    price: priceFromRate(tripKm, vehicleType),
    tripKm: Number(tripKm.toFixed(3)),
    actualDurationSec: actualDurationSecVal,
    expectedDurationSec: expectedSec,
    trafficFactor: Number((expectedSec > 0 ? (actualDurationSecVal / expectedSec) : 1).toFixed(2)),
    surge: 1.0
  };
}

/* ---------------- Cancel Trip API (driver clicks Cancel) ---------------- */
app.post('/api/ride/:rideId/cancel', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { reason, note } = req.body || {};
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    // grab the last known driver location (if any)
    let cancelLat = null, cancelLng = null;
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (drv?.location && typeof drv.location.lat === 'number' && typeof drv.location.lng === 'number') {
        cancelLat = drv.location.lat; cancelLng = drv.location.lng;
        await appendPathPoint(ride._id, cancelLat, cancelLng, 'CANCEL');
      }
    }

    // stamp cancellation
    if (ride.status !== 'cancelled') {
      ride.status = 'cancelled';
      try {
        ride.cancellationReason = reason || null;
        ride.cancellationNote = (reason === 'Other' ? (note || '') : note) || null;
      } catch {}
      ride.cancelledAt = new Date();
      ride.cancelledBy = 'driver';
      await ride.save();
    }

    // console log
    if (cancelLat != null && cancelLng != null) {
      console.log(`❌ CANCELLED ride=${rideId} reason="${reason || ''}" lat=${cancelLat.toFixed(6)} lng=${cancelLng.toFixed(6)}`);
    } else {
      console.log(`❌ CANCELLED ride=${rideId} reason="${reason || ''}" (no last driver coords)`);
    }

    // notify rider (optional)
    const riderChatId = ride.riderChatId || ride.riderTelegramChatId || ride.rider?.chatId || null;
    if (riderChatId && riderBot) {
      const cleanReason = String(reason || 'Trip cancelled').trim();
      const cleanNote = (note ? String(note).trim() : '');
      const msg =
        `❌ <b>Your trip was cancelled by the driver.</b>\n` +
        `• Reason: <i>${cleanReason}</i>` +
        (cleanNote ? `\n• Note: ${cleanNote}` : '');
      try { await riderBot.sendMessage(Number(riderChatId), msg, { parse_mode: 'HTML' }); } catch {}
    }

    await logActivity({
      rideId: ride._id,
      type: 'cancelled',
      actorType: 'driver',
      message: `Ride cancelled (${reason || 'unspecified'})`,
      meta: { reason: reason || null, note: note || null, lat: cancelLat, lng: cancelLng }
    });

    io.emit(`ride:${rideId}:cancelled`, { reason: reason || null });

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/cancel error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- Finish Trip API (driver clicks Finish) ---------------- */
/* ---------------- Finish Trip API (driver clicks Finish) ---------------- */
/* ---------------- Finish Trip API (driver clicks Finish) ---------------- */
app.post('/api/ride/:rideId/finish', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { paidMethod } = req.body || {};
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    // stamp final coords before computing/saving
    let endLat = null, endLng = null;
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (drv?.location && typeof drv.location.lat === 'number' && typeof drv.location.lng === 'number') {
        endLat = drv.location.lat; endLng = drv.location.lng;
        await appendPathPoint(ride._id, endLat, endLng, 'FINISH');
      }
    }

    const {
      price,
      tripKm,
      actualDurationSec,
      expectedDurationSec,
      trafficFactor,
      surge
    } = await computeFinalFare({
      pickup: ride.pickup,
      destination: ride.destination,
      vehicleType: ride.vehicleType || 'normal',
      path: ride.path || null,
      createdAt: ride.createdAt,
      pickedAt: ride.pickedAt || ride.startedAt || ride.createdAt,
      completedAt: new Date()
    });

    ride.status = 'completed';
    ride.completedAt = new Date();

    // ✅ normalize to 'cash' | 'payfast' only
    ride.paymentMethod = (paidMethod === 'cash') ? 'cash' : 'payfast';

    // ✅ ADDED: defensively mark cash rides as paid at finish
    if (ride.paymentMethod === 'cash' && ride.paymentStatus !== 'paid') {
      ride.paymentStatus = 'paid';
      ride.paidAt = new Date();
    }

    ride.finalAmount = price;
    ride.finalDistanceKm = tripKm;
    ride.finalDurationSec = actualDurationSec;
    ride.finalTrafficFactor = trafficFactor;
    ride.finalSurge = surge;

    await ride.save();

    // ✅ refresh driver stats + DM their receipt
    try { await notifyDriverRideFinished(ride._id); } catch {}

    const locStr = (endLat != null && endLng != null)
      ? `lat=${endLat.toFixed(6)} lng=${endLng.toFixed(6)}`
      : 'no last driver coords';
    console.log(`🏁 FINISHED ride=${rideId} method=${ride.paymentMethod} amount=R${price} dist=${tripKm.toFixed(2)}km dur=${actualDurationSec}s (${locStr})`);

    io.emit(`ride:${rideId}:finished`, {
      paidMethod: ride.paymentMethod,
      amount: price,
      distanceKm: tripKm
    });

    return res.json({
      ok: true,
      paidMethod: ride.paymentMethod,
      paymentStatus: ride.paymentStatus,   // <- helpful for UI
      amount: price,
      distanceKm: tripKm,
      durationSec: actualDurationSec
    });
  } catch (e) {
    console.error('finish error', e);
    res.status(500).json({ error: 'Failed to finish trip' });
  }
});


/* ---------------- Socket.IO ---------------- */
io.on('connection', (sock) => {
  console.log('🔌 Socket connected:', sock.id);

  /* Driver’s browser can stream HTML5 GPS */
  sock.on('driver:mapLocation', async (payload = {}) => {
    try {
      const { rideId, chatId, lat, lng } = payload || {};
      if (!rideId || !Number.isFinite(Number(chatId))) return;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;

      // Validate: this chatId must be the driver assigned to this ride
      const ride = await Ride.findById(rideId).lean();
      if (!ride || !ride.driverId) return;

      const drv = await Driver.findById(ride.driverId).lean();
      if (!drv || Number(drv.chatId) !== Number(chatId)) return;

      // Update DB so /api/driver-last-loc works as well
      await Driver.findOneAndUpdate(
        { _id: drv._id },
        { $set: { location: { lat, lng }, lastSeenAt: new Date(), isAvailable: true } },
        { new: true }
      );

      // Reuse the same broadcast path as Telegram updates
      driverEvents.emit('driver:location', { chatId: Number(chatId), location: { lat, lng } });
    } catch (e) {
      console.warn('driver:mapLocation error:', e?.message || e);
    }
  });
});

/* ---------------- Start server ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
