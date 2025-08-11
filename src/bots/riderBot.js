// src/bots/riderBot.js
import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import crypto from 'crypto';
import { estimatePrice } from '../services/pricing.js';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';

export const riderEvents = new EventEmitter();

const token = process.env.TELEGRAM_RIDER_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_RIDER_BOT_TOKEN is not defined in .env');

// Singleton bot + io reference
let riderBot = null;
let ioRef = null;

// Conversation state
const riderState = new Map();

/* ---------------- Token/PIN dashboard helpers ---------------- */

function generatePIN() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Save token+pin+expiry and DM the rider
async function sendDashboardLink(chatId) {
  const dashboardToken = generateToken();
  const dashboardPin = generatePIN();
  const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

  // Persist to DB
  await Rider.findOneAndUpdate(
    { chatId },
    {
      chatId,
      dashboardToken,
      dashboardPin,
      dashboardTokenExpiry: expiry
    },
    { upsert: true }
  );

  const link = `${process.env.PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
  await riderBot.sendMessage(
    chatId,
    `🔐 Dashboard link:\n${link}\n\n🔢 Your PIN: <b>${dashboardPin}</b>\n⏱️ Expires in 10 mins`,
    { parse_mode: 'HTML' }
  );
}

/* ---------------- rider live-location helper ---------------- */

async function emitRiderLocation(chatId, loc) {
  // persist for debugging/analytics (optional)
  await Rider.findOneAndUpdate(
    { chatId },
    { $set: { lastLocation: loc, lastSeenAt: new Date() } },
    { upsert: true }
  );

  // notify server.js (which will tick/log every second)
  riderEvents.emit('rider:location', { chatId, location: loc });

  // also broadcast over websockets if any UI is listening
  try {
    ioRef?.emit('rider:location', { chatId, location: loc });
  } catch {}
}

/* ---------------- core handlers ---------------- */

function wireRiderHandlers() {
  if (wireRiderHandlers._wired) return;
  wireRiderHandlers._wired = true;

  /* /start */
  riderBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    riderState.delete(chatId);

    const rider = await Rider.findOne({ chatId });

    if (!rider) {
      riderState.set(chatId, { step: 'awaiting_name' });
      return riderBot.sendMessage(chatId, '👋 Welcome! Please enter your full name to register:');
    }

    return riderBot.sendMessage(chatId, '👋 Welcome back! Choose an option:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚕 Book Trip', callback_data: 'book_trip' }],
          [{ text: '💳 Add Credit', callback_data: 'open_dashboard' }],
          [{ text: '👤 Profile', callback_data: 'open_dashboard' }],
          [{ text: '❓ Help Desk', url: 'https://t.me/yourSupportBot' }]
        ]
      }
    });
  });

  /* registration + general messages
     NOTE: we still accept location messages anywhere and forward them. */
  riderBot.on('message', async (msg) => {
    // If it’s a location (either one-off “Send my current location”
    // or live-location first message), forward it for logging/ticker.
    if (msg.location) {
      const chatId = msg.chat.id;
      const { latitude, longitude } = msg.location;
      await emitRiderLocation(chatId, { lat: latitude, lng: longitude });
      // do NOT return; booking flow below may still apply if we’re mid-flow
    }

    const chatId = msg.chat.id;
    const state = riderState.get(chatId);
    if (!state || !state.step) return;

    const text = msg.text?.trim();
    if (!text) return;

    if (state.step === 'awaiting_name') {
      state.name = text;
      state.step = 'awaiting_email';
      riderState.set(chatId, state);
      return riderBot.sendMessage(chatId, '📧 Enter your email address:');
    }

    if (state.step === 'awaiting_email') {
      state.email = text;
      state.step = 'awaiting_credit';
      riderState.set(chatId, state);
      return riderBot.sendMessage(chatId, '💰 Enter your starting credit (e.g. 100):');
    }

    if (state.step === 'awaiting_credit') {
      const credit = parseFloat(text);
      if (isNaN(credit)) {
        return riderBot.sendMessage(chatId, '❌ Invalid amount. Enter a number.');
      }

      const dashboardToken = generateToken();
      const dashboardPin = generatePIN();
      const expiry = new Date(Date.now() + 10 * 60 * 1000);

      await Rider.create({
        chatId,
        name: state.name,
        email: state.email,
        credit,
        dashboardToken,
        dashboardPin,
        dashboardTokenExpiry: expiry
      });

      riderState.delete(chatId);

      const link = `${process.env.PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
      return riderBot.sendMessage(
        chatId,
        `✅ Registration complete!\n\n🔐 Dashboard link:\n${link}\n\n🔢 Your PIN: <b>${dashboardPin}</b>\n⏱️ Expires in 10 mins`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚕 Book Trip', callback_data: 'book_trip' }],
              [{ text: '💳 Add Credit', callback_data: 'open_dashboard' }],
              [{ text: '👤 Profile', callback_data: 'open_dashboard' }],
              [{ text: '❓ Help Desk', url: 'https://t.me/yourSupportBot' }]
            ]
          }
        }
      );
    }
  });

  /* callback buttons */
  riderBot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
      if (data === 'open_dashboard') {
        await sendDashboardLink(chatId);
        return;
      }

      if (data === 'book_trip') {
        const rider = await Rider.findOne({ chatId });
        if (!rider) {
          riderState.set(chatId, { step: 'awaiting_name' });
          return riderBot.sendMessage(chatId, '🚨 Please register first. Enter your full name:');
        }

        riderBot.sendMessage(chatId, '📍 Send your pickup location', {
          reply_markup: {
            keyboard: [[{ text: 'Send Pickup 📍', request_location: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });

        riderState.set(chatId, { step: 'awaiting_pickup' });
        return;
      }

      // New format: veh:<type>:<price>
      if (data.startsWith('veh:')) {
        const [, vehicle, priceStr] = data.split(':');
        const price = Number(priceStr);
        const st = riderState.get(chatId);

        if (!st || !st.pickup || !st.destination || Number.isNaN(price)) {
          riderState.set(chatId, { step: 'awaiting_pickup' });
          await riderBot.sendMessage(chatId, '⚠️ Session expired. Please send your pickup location again.', {
            reply_markup: {
              keyboard: [[{ text: 'Send Pickup 📍', request_location: true }]],
              resize_keyboard: true,
              one_time_keyboard: true
            }
          });
          return;
        }

        const ride = await Ride.create({
          riderChatId: chatId,
          pickup: st.pickup,
          destination: st.destination,
          estimate: price,
          vehicleType: vehicle,
          status: 'payment_pending'
        });

        const payfastRedirect = `${process.env.PUBLIC_URL}/pay/${ride._id}`;
        await riderBot.sendMessage(chatId, '💳 Choose your payment method:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💵 Cash', callback_data: `pay_cash_${ride._id}` }],
              [{ text: '💳 Pay with Card', url: payfastRedirect }]
            ]
          }
        });

        riderState.set(chatId, { ...st, step: 'awaiting_payment' });
        return;
      }

      // legacy vehicle_<type>
      if (data.startsWith('vehicle_')) {
        const vehicle = data.replace('vehicle_', '');
        const st = riderState.get(chatId);

        if (!st || !st.pickup || !st.destination) {
          riderState.set(chatId, { step: 'awaiting_pickup' });
          await riderBot.sendMessage(chatId, '⚠️ Session expired. Please send your pickup location again.', {
            reply_markup: {
              keyboard: [[{ text: 'Send Pickup 📍', request_location: true }]],
              resize_keyboard: true,
              one_time_keyboard: true
            }
          });
          return;
        }

        const { price } = estimatePrice({
          pickup: st.pickup,
          destination: st.destination,
          driverLocation: null
        });

        const ride = await Ride.create({
          riderChatId: chatId,
          pickup: st.pickup,
          destination: st.destination,
          estimate: price,
          vehicleType: vehicle,
          status: 'payment_pending'
        });

        const payfastRedirect = `${process.env.PUBLIC_URL}/pay/${ride._id}`;
        await riderBot.sendMessage(chatId, '💳 Choose your payment method:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💵 Cash', callback_data: `pay_cash_${ride._id}` }],
              [{ text: '💳 Pay with Card', url: payfastRedirect }]
            ]
          }
        });

        riderState.set(chatId, { ...st, step: 'awaiting_payment' });
        return;
      }

      // cash
      if (data.startsWith('pay_cash_')) {
        const rideId = data.replace('pay_cash_', '');
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        ride.status = 'pending';
        await ride.save();

        riderEvents.emit('booking:new', {
          chatId,
          pickup: ride.pickup,
          destination: ride.destination,
          payment: 'cash'
        });

        await riderBot.sendMessage(chatId, '✅ Your ride is being requested...');
        riderState.delete(chatId);
        return;
      }
    } catch (err) {
      console.error('callback_query error:', err);
      await riderBot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
    }
  });

  /* location during booking + general */
  riderBot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    const coords = { lat: latitude, lng: longitude };

    // forward for ticker + map
    await emitRiderLocation(chatId, coords);

    // booking flow
    const state = riderState.get(chatId);
    if (!state) return;

    if (state.step === 'awaiting_pickup') {
      state.pickup = coords;
      state.step = 'awaiting_drop';
      riderState.set(chatId, state);

      await riderBot.sendMessage(chatId, '📍 Now send your destination location', {
        reply_markup: {
          keyboard: [[{ text: 'Send Drop 📍', request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
      return;
    }

    if (state.step === 'awaiting_drop') {
      state.destination = coords;
      state.step = 'selecting_vehicle';

      const base = estimatePrice({
        pickup: state.pickup,
        destination: state.destination,
        driverLocation: null
      }).price;

      const prices = {
        sedan: Math.round(base),
        suv: Math.round(base * 1.2),
        hatch: Math.round(base * 0.9)
      };

      state.prices = prices;
      riderState.set(chatId, state);

      await riderBot.sendMessage(chatId, '🚘 Select your ride:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🚗 Sedan - R${prices.sedan}`, callback_data: `veh:sedan:${prices.sedan}` }],
            [{ text: `🚙 SUV - R${prices.suv}`, callback_data: `veh:suv:${prices.suv}` }],
            [{ text: `🚘 Hatch - R${prices.hatch}`, callback_data: `veh:hatch:${prices.hatch}` }]
          ]
        }
      });
    }
  });

  /* LIVE location edits from Telegram */
  riderBot.on('edited_message', async (msg) => {
    if (!msg?.location) return;
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location;
    await emitRiderLocation(chatId, { lat: latitude, lng: longitude });
  });
}

/* --------------------- Init & exports --------------------- */

export function initRiderBot(io) {
  if (riderBot) {
    ioRef = io || ioRef;
    console.log('🤖 Rider bot already initialized');
    return riderBot;
  }

  ioRef = io || null;

  // IMPORTANT: allow edited_message so live location edits arrive
  riderBot = new TelegramBot(token, {
    polling: {
      interval: 300,
      autoStart: true,
      params: {
        timeout: 10,
        allowed_updates: ['message', 'edited_message', 'callback_query']
      }
    }
  });

  wireRiderHandlers();

  console.log('🤖 Rider bot initialized');
  return riderBot;
}

export { riderBot };
