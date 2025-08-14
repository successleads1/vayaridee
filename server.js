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

/* ---- Bots ---- */
import { initRiderBot, riderEvents, riderBot as RB } from './src/bots/riderBot.js';
import { initDriverBot, driverEvents, driverBot as DB } from './src/bots/driverBot.js';
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

/* ---------------- Mongo ---------------- */
await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ MongoDB connected');

/* ---------------- Init Bots ---------------- */
initWhatsappBot();                  // WhatsApp (new)
const riderBot = initRiderBot(io);  // Telegram rider (unchanged)
const driverBot = initDriverBot(io);// Telegram driver (unchanged)
console.log('🤖 Rider bot initialized');
console.log('🚗 Driver bot initialized');

/* ---------------- App setup ---------------- */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public'))); // serves /wa-qr.png
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

/* Rider dashboard token API (legacy) */
app.get('/api/rider-by-token/:token', async (req, res) => {
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

  res.json({
    chatId: rider.chatId,
    name: rider.name,
    email: rider.email,
    credit: rider.credit,
    trips: rider.trips || 0
  });
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
    // wait up to 25s for a fresh QR if none cached
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
app.post('/api/update-profile', async (req, res) => {
  const { chatId, name, email, credit } = req.body;
  if (!chatId || isNaN(Number(chatId))) {
    return res.status(400).send('❌ Invalid or missing chatId.');
  }

  const rider = await Rider.findOne({ chatId: Number(chatId) });
  if (!rider) {
    return res.status(403).send('<h2>❌ Unauthorized: Rider not found</h2>');
  }

  rider.name = name;
  rider.email = email;
  rider.credit = credit;
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

/* Map/track page (BACK-COMPAT): redirect /map/:rideId -> track.html?rideId=... */
app.get('/map/:rideId', (req, res) => {
  const url = `/track.html?rideId=${encodeURIComponent(req.params.rideId)}`;
  res.redirect(302, url);
});

/* ---------------- Tracking APIs ---------------- */

/** IMPORTANT: return driverChatId so the map can subscribe to driver fallback channel */
app.get('/api/ride/:rideId', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId).lean();
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    let driverChatId = null;
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (drv && typeof drv.chatId === 'number') driverChatId = drv.chatId;
    }

    res.json({
      pickup: ride.pickup,
      destination: ride.destination,
      riderName: 'RIDER',
      driverChatId
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

/** Return last known driver location (by Telegram chatId) */
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

/* ---------------- Live driver broadcasts ---------------- */
driverEvents.on('driver:location', async ({ chatId, location }) => {
  try {
    console.log(`🛰  SOCKET OUT driver:${chatId}:location lat=${location.lat} lng=${location.lng}`);
    io.emit(`driver:${chatId}:location`, location);

    const ride = await Ride.findOne({ driverId: { $exists: true }, status: 'accepted' })
      .sort({ updatedAt: -1 })
      .lean();
    if (ride) {
      console.log(`🛰  SOCKET OUT ride:${ride._id}:driverLocation lat=${location.lat} lng=${location.lng}`);
      io.emit(`ride:${ride._id}:driverLocation`, location);
    }
  } catch (e) {
    console.warn('driver:location broadcast failed:', e?.message || e);
  }
});

/* ---------------- BOOKING DISPATCH PIPELINE ---------------- */

async function dispatchToNearestDriver({ rideId, excludeDriverIds = [] }) {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'pending') return;

  // Choose nearest driver (Telegram)
  const chosen = await assignNearestDriver(ride.pickup, {
    vehicleType: ride.vehicleType || null,
    exclude: excludeDriverIds
  });

  if (!chosen || !hasNumericChatId(chosen)) {
    try {
      if (ride.riderChatId) {
        await RB.sendMessage(ride.riderChatId, '😕 No drivers are available right now. We will keep trying shortly.');
      }
    } catch {}
    try {
      if (ride.riderWaJid) {
        await sendWhatsAppMessage(ride.riderWaJid, '😕 No drivers are available right now. We will keep trying shortly.');
      }
    } catch {}
    return;
  }

  // Optional estimate using chosen driver location (if you want)
  try { await setEstimateOnRide(ride._id, chosen.location || null); } catch {}

  // Log assignment
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

/* Events (unchanged; WA notices added when applicable) */
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

    const link = `${process.env.PUBLIC_URL}/track.html?rideId=${encodeURIComponent(rideId)}`;
    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, `🚗 Your ride is on the way. Track here:\n${link}`); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, `🚗 Your ride is on the way. Track here:\n${link}`); } catch {}
    try { await DB.sendMessage(driverId, `🗺️ Open the live trip map:\n${link}`); } catch {}
  } catch (e) {
    console.warn('ride:accepted handler failed:', e?.message || e);
  }
});

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
  } catch (e) {
    console.warn('ride:arrived handler failed:', e?.message || e);
  }
});

driverEvents.on('ride:started', async ({ rideId }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    await logActivity({
      rideId,
      type: 'started',
      actorType: 'driver',
      message: 'Trip started'
    });

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
  } catch (e) {
    console.warn('ride:started handler failed:', e?.message || e);
  }
});

driverEvents.on('ride:cancelled', async ({ ride, reason }) => {
  try {
    if (!ride) return;

    await logActivity({
      rideId: ride._id,
      type: 'cancelled',
      actorType: 'driver',
      message: `Driver cancelled the trip: ${reason}`,
      meta: { reason }
    });

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, `❌ The driver cancelled the trip.\nReason: ${reason}`); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, `❌ The driver cancelled the trip.\nReason: ${reason}`); } catch {}
  } catch (e) {
    console.warn('ride:cancelled handler failed:', e?.message || e);
  }
});

/* ---------------- Start server ---------------- */
io.on('connection', (sock) => console.log('🔌 Socket connected:', sock.id));
server.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
