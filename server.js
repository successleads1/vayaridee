// server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import mongoose from 'mongoose';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import morgan from 'morgan';
import session from 'express-session';
// import MongoStore from 'connect-mongo';

import { initRiderBot, riderEvents, riderBot as RB } from './src/bots/riderBot.js';
import { initDriverBot, driverEvents, driverBot as DB } from './src/bots/driverBot.js';
import { assignNearestDriver } from './src/services/assignment.js';
import { estimatePrice } from './src/services/pricing.js';
import Ride from './src/models/Ride.js';
import Driver from './src/models/Driver.js';
import Rider from './src/models/Rider.js';

import passport from './src/auth/passport.js';
import driverAuthRouter from './src/routes/driverAuth.js';
import adminRouter from './src/routes/admin.js';

// 🔐 Admin seed imports (must be at top)
import bcrypt from 'bcrypt';
import Admin from './src/models/Admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

// expose io to routes via req.app.get('io')
app.set('io', io);

const PORT = process.env.PORT || 3000;

/* ---------------- Mongo ---------------- */
await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ MongoDB connected');

// 🔐 Seed a default admin if env vars are present
async function ensureSeedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('⚠️ Skipping admin seed: ADMIN_EMAIL/ADMIN_PASSWORD not set');
    return;
  }
  try {
    const existing = await Admin.findOne({ email: ADMIN_EMAIL });
    if (existing) {
      console.log('🛡️ Admin already exists:', ADMIN_EMAIL);
      return;
    }
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await Admin.create({
      name: ADMIN_NAME || 'Super Admin',
      email: ADMIN_EMAIL,
      passwordHash
    });
    console.log('🛡️ Seeded admin:', ADMIN_EMAIL);
  } catch (err) {
    console.error('❌ Failed to seed admin:', err.message);
  }
}
await ensureSeedAdmin();

// 🔧 One-time/starter cleanup: drop stale/overly-strict driver indexes
try {
  const coll = mongoose.connection.db.collection('drivers');
  const indexes = await coll.indexes();
  const names = indexes.map(i => i.name);
  console.log('🧭 drivers indexes:', names);

  if (names.includes('phone_1')) {
    await coll.dropIndex('phone_1');
    console.log('🧹 Dropped stale index: phone_1');
  }
  if (names.includes('chatId_1')) {
    await coll.dropIndex('chatId_1');
    console.log('🧹 Dropped stale index: chatId_1');
  }

  // Clean any docs that literally have chatId: null
  await coll.updateMany({ chatId: null }, { $unset: { chatId: 1 } });

  // Recreate as unique only when chatId is a number
  await coll.createIndex(
    { chatId: 1 },
    {
      name: 'chatId_1_notnull_unique',
      unique: true,
      partialFilterExpression: { chatId: { $type: 'number' } }
    }
  );
  console.log('🔐 Recreated chatId_1 as partial unique (only numeric chatId).');

  const after = await coll.indexes();
  console.log('🧭 drivers indexes (after):', after.map(i => i.name));
} catch (err) {
  console.warn('⚠️ Index cleanup skipped or failed:', err.message);
}

/* ---------------- Bots ---------------- */
const riderBot = initRiderBot(io);
const driverBot = initDriverBot(io);

/* ---------------- Views ---------------- */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

/* ---------------- Logging ---------------- */
app.use(morgan('dev'));

/* ---------------- Static ---------------- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- Body parsers (before routers) ---------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------------- Sessions ---------------- */
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'devsecret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 12 * 60 * 60 * 1000 },
    // store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI })
  })
);

/* ---------------- Passport ---------------- */
app.use(passport.initialize());
app.use(passport.session());

// ✅ Make `user` available to ALL EJS views
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  next();
});

/* ---------------- Landing ---------------- */
app.get('/', (req, res) => {
  res.render('landing', { title: 'VayaRide' });
});

/* ---------------- Driver web portal ---------------- */
app.use('/driver', driverAuthRouter);

/* ---------------- Admin portal ---------------- */
app.use('/admin', adminRouter);

/* ---------------- Rider Dashboard secure token API ---------------- */
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

/* ---------------- Update rider profile ---------------- */
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

/* ---------------- Legacy rider fetch ---------------- */
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

/* ---------------- Telegram bot webhooks (optional; safe to leave) ---------------- */
app.post('/rider-bot', (req, res) => {
  riderBot.processUpdate?.(req.body);
  res.sendStatus(200);
});

app.post('/driver-bot', (req, res) => {
  driverBot.processUpdate?.(req.body);
  res.sendStatus(200);
});

/* ---------------- Pay route ---------------- */
app.use('/pay', (await import('./src/routes/payfast.js')).default);

/* ---------------- Public Map ---------------- */
app.get('/map/:rideId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/map.html'));
});

/* IMPORTANT: return driverChatId so the map can subscribe to driver fallback channel */
app.get('/api/ride/:rideId', async (req, res) => {
  const ride = await Ride.findById(req.params.rideId);
  if (!ride) return res.status(404).json({ error: 'Ride not found' });

  let driver = null;
  if (ride.driverId) driver = await Driver.findById(ride.driverId);

  res.json({
    pickup: ride.pickup,
    destination: ride.destination,
    riderName: 'Rider',
    driverName: driver?.name || 'Driver',
    driverChatId: driver?.chatId ?? null   // 👈 NEW
  });
});

/* ---------------- WebSockets ---------------- */
io.on('connection', socket => {
  console.log('🔌 Socket connected:', socket.id);

  // Browser viewer live-location logging (from map.html)
  socket.on('viewer:location', (payload) => {
    // payload: { rideId, lat, lng, ts }
    if (!payload || typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return;
    console.log(
      `🧭 Viewer ${socket.id} [ride ${payload.rideId}] @ ${payload.ts} -> lat=${payload.lat}, lng=${payload.lng}`
    );
  });
});

/* ---------------- Driver live location events ---------------- */
driverEvents.on('driver:location', async ({ driverId, location }) => {
  const driver = await Driver.findOne({ chatId: driverId });
  if (!driver) return;

  const ride = await Ride.findOne({
    driverId: driver._id,
    status: { $in: ['pending', 'accepted', 'enroute'] }
  });

  // Emit per ride (as before)
  if (ride) {
    io.emit(`ride:${ride._id}:driverLocation`, location);
    console.log(`📡 Emitting driver location for ride ${ride._id}:`, location);
  }

  // 👇 ALSO emit a generic channel by driver chatId (fallback for map)
  if (typeof driver.chatId === 'number') {
    io.emit(`driver:${driver.chatId}:location`, location);
  }
});

/* ---------------- Rider live location relay ---------------- */
// We keep socket broadcast but STOP console.log spam from Telegram rider.
// (The per-second ticker has been removed.)
const riderLatest = new Map();   // chatId -> { lat, lng }

riderEvents.on('rider:location', ({ chatId, location }) => {
  riderLatest.set(chatId, location);
  io.emit(`rider:${chatId}:location`, location);
  // ✅ No more per-second console.log for riders.
});

/* ---------------- Helpers for safe driver send ---------------- */
function hasNumericChatId(d) {
  return d && typeof d.chatId !== 'undefined' && !Number.isNaN(Number(d.chatId));
}

async function sendOfferToDriver(driver, ride, ioInstance, DriverBot) {
  if (!hasNumericChatId(driver)) {
    console.warn('⚠️ Cannot send offer — driver has no numeric chatId', {
      driverId: String(driver?._id || ''),
      chatId: driver?.chatId
    });
    return false;
  }

  const mapLink = `${process.env.PUBLIC_URL}/map/${ride._id}`;
  const price = ride.estimate;

  try {
    await DriverBot.sendMessage(
      Number(driver.chatId),
      `🚘 New Ride Request
Pickup: ${ride.pickup.lat},${ride.pickup.lng}
Destination: ${ride.destination.lat},${ride.destination.lng}
💰 R${price}
📍 ${mapLink}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Accept', callback_data: `accept_${ride._id}` },
            { text: '❌ Ignore', callback_data: `ignore_${ride._id}` }
          ]]
        }
      }
    );
    return true;
  } catch (err) {
    console.error('❌ Failed to send offer to driver:', {
      driverId: String(driver._id),
      chatId: driver.chatId,
      err: err?.message || err
    });
    return false;
  }
}

/* ---------------- Booking events ---------------- */
riderEvents.on('booking:new', async ({ chatId, pickup, destination, payment }) => {
  try {
    const { price } = estimatePrice({ pickup, destination });

    const ride = await Ride.create({
      riderChatId: chatId,
      pickup,
      destination,
      estimate: price,
      status: payment === 'cash' ? 'pending' : 'payment_pending'
    });

    await Rider.findOneAndUpdate({ chatId }, { $inc: { trips: 1 } }, { upsert: true });

    if (payment !== 'cash') {
      const payLink = `${process.env.PUBLIC_URL}/pay/${ride._id}`;
      await RB.sendMessage(chatId, `💳 Please complete payment:\n${payLink}`);
      return;
    }

    // Cash flow: assign nearest driver (must be online, linked, with location)
    let driver = await assignNearestDriver(pickup);
    if (!driver) {
      console.log('❌ No eligible (online + linked) drivers with location');
      await RB.sendMessage(chatId, '❌ No drivers available at the moment.');
      return;
    }

    // If the chosen driver has no numeric chatId, try the next
    if (!hasNumericChatId(driver)) {
      console.warn('⚠️ Assigned driver missing chatId, searching for another', {
        driverId: String(driver._id)
      });
      driver = await assignNearestDriver(pickup, [driver._id]);
      if (!driver) {
        await RB.sendMessage(chatId, '❌ No linked drivers available right now.');
        return;
      }
    }

    // Link the ride to the chosen driver in DB
    ride.driverId = driver._id;
    await ride.save();

    const ok = await sendOfferToDriver(driver, ride, io, DB);
    if (!ok) {
      // fall back once more
      const alt = await assignNearestDriver(pickup, [driver._id]);
      if (!alt) {
        await RB.sendMessage(ride.riderChatId, '❌ Could not reach any drivers. Please try again shortly.');
        return;
      }
      ride.driverId = alt._id;
      await ride.save();

      const ok2 = await sendOfferToDriver(alt, ride, io, DB);
      if (!ok2) {
        await RB.sendMessage(ride.riderChatId, '❌ Could not reach drivers. Please try again shortly.');
      }
    }
  } catch (err) {
    console.error('booking:new handler error:', err);
    try { await RB.sendMessage(chatId, '⚠️ Something went wrong starting your ride. Please try again.'); } catch {}
  }
});

driverEvents.on('ride:accepted', async ({ driverId, rideId }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    const driver = await Driver.findOne({ chatId: Number(driverId) });
    if (!driver) return;

    ride.status = 'accepted';
    ride.driverId = driver._id;
    await ride.save();

    const mapLink = `${process.env.PUBLIC_URL}/map/${ride._id}`;
    await RB.sendMessage(ride.riderChatId, `🚖 Driver accepted your ride!\nView driver location:\n${mapLink}`);
  } catch (err) {
    console.error('ride:accepted handler error:', err);
  }
});

driverEvents.on('ride:ignored', async ({ previousDriverId, ride }) => {
  try {
    const newDriver = await assignNearestDriver(ride.pickup, [ride.driverId, previousDriverId]);
    if (!newDriver) {
      await RB.sendMessage(ride.riderChatId, '⚠️ No other drivers available at the moment.');
      return;
    }

    ride.driverId = newDriver._id;
    ride.status = 'pending';
    await ride.save();

    const ok = await sendOfferToDriver(newDriver, ride, io, DB);
    if (!ok) {
      await RB.sendMessage(ride.riderChatId, '⚠️ Could not reach the next driver. We’re still trying.');
    }
  } catch (err) {
    console.error('ride:ignored handler error:', err);
  }
});

driverEvents.on('ride:cancelled', async ({ ride, reason }) => {
  await RB.sendMessage(ride.riderChatId, `⚠️ Your driver has cancelled the ride.\nReason: ${reason}`);
});

/* ---------------- Start ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
