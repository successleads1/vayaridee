// src/bots/riderBot.js
import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import crypto from 'crypto';
import { getAvailableVehicleQuotes } from '../services/pricing.js';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';

export const riderEvents = new EventEmitter();

const token = process.env.TELEGRAM_RIDER_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_RIDER_BOT_TOKEN is not defined in .env');

let riderBot = null;
let ioRef = null;
const riderState = new Map();

function generatePIN() { return Math.floor(1000 + Math.random() * 9000).toString(); }
function generateToken() { return crypto.randomBytes(24).toString('hex'); }

async function sendDashboardLink(chatId) {
  const dashboardToken = generateToken();
  const dashboardPin = generatePIN();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  await Rider.findOneAndUpdate(
    { chatId },
    { chatId, dashboardToken, dashboardPin, dashboardTokenExpiry: expiry },
    { upsert: true }
  );
  const link = `${process.env.PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
  await riderBot.sendMessage(chatId, `🔐 Dashboard link:\n${link}\n\n🔢 Your PIN: <b>${dashboardPin}</b>\n⏱️ Expires in 10 mins`, { parse_mode: 'HTML' });
}

async function emitRiderLocation(chatId, loc) {
  await Rider.findOneAndUpdate(
    { chatId },
    { $set: { lastLocation: loc, lastSeenAt: new Date() } },
    { upsert: true }
  );
  try { ioRef?.emit('rider:location', { chatId, location: loc }); } catch {}
}

function wireRiderHandlers() {
  if (wireRiderHandlers._wired) return;
  wireRiderHandlers._wired = true;

  riderBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    riderState.delete(chatId);
    const rider = await Rider.findOne({ chatId });
    if (!rider) {
      riderState.set(chatId, { step: 'awaiting_name' });
      return riderBot.sendMessage(chatId, '👋 Welcome! Please enter your full name to register:');
    }
    return riderBot.sendMessage(chatId, '👋 Welcome back! Choose an option:', {
      reply_markup: { inline_keyboard: [
        [{ text: '🚕 Book Trip', callback_data: 'book_trip' }],
        [{ text: '💳 Add Credit', callback_data: 'open_dashboard' }],
        [{ text: '👤 Profile', callback_data: 'open_dashboard' }],
        [{ text: '❓ Help Desk', url: 'https://t.me/yourSupportBot' }]
      ] }
    });
  });

  riderBot.on('message', async (msg) => {
    if (msg.location) {
      const chatId = msg.chat.id;
      const { latitude, longitude } = msg.location;
      await emitRiderLocation(chatId, { lat: latitude, lng: longitude });
    }

    const chatId = msg.chat.id;
    const state = riderState.get(chatId);
    if (!state || !state.step) return;

    const text = msg.text?.trim();
    if (!text) return;

    if (state.step === 'awaiting_name') {
      state.name = text; state.step = 'awaiting_email'; riderState.set(chatId, state);
      return riderBot.sendMessage(chatId, '📧 Enter your email address:');
    }
    if (state.step === 'awaiting_email') {
      state.email = text; state.step = 'awaiting_credit'; riderState.set(chatId, state);
      return riderBot.sendMessage(chatId, '💰 Enter your starting credit (e.g. 100):');
    }
    if (state.step === 'awaiting_credit') {
      const credit = parseFloat(text);
      if (isNaN(credit)) return riderBot.sendMessage(chatId, '❌ Invalid amount. Enter a number.');
      const dashboardToken = generateToken();
      const dashboardPin = generatePIN();
      const expiry = new Date(Date.now() + 10 * 60 * 1000);
      await Rider.create({ chatId, name: state.name, email: state.email, credit, dashboardToken, dashboardPin, dashboardTokenExpiry: expiry });
      riderState.delete(chatId);
      const link = `${process.env.PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
      return riderBot.sendMessage(chatId,
        `✅ Registration complete!\n\n🔐 Dashboard link:\n${link}\n\n🔢 Your PIN: <b>${dashboardPin}</b>\n⏱️ Expires in 10 mins`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🚕 Book Trip', callback_data: 'book_trip' }],
            [{ text: '💳 Add Credit', callback_data: 'open_dashboard' }],
            [{ text: '👤 Profile', callback_data: 'open_dashboard' }],
            [{ text: '❓ Help Desk', url: 'https://t.me/yourSupportBot' }]
          ] }
        }
      );
    }
  });

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
            resize_keyboard: true, one_time_keyboard: true
          }
        });
        riderState.set(chatId, { step: 'awaiting_pickup' });
        return;
      }

      // Rider picks vehicle button ('veh:<vehicleType>:<price>')
      if (data.startsWith('veh:')) {
        const [, vehicleType, priceStr] = data.split(':');
        const price = Number(priceStr);
        const st = riderState.get(chatId);
        if (!st || !st.pickup || !st.destination || Number.isNaN(price)) {
          riderState.set(chatId, { step: 'awaiting_pickup' });
          await riderBot.sendMessage(chatId, '⚠️ Session expired. Please send your pickup location again.', {
            reply_markup: {
              keyboard: [[{ text: 'Send Pickup 📍', request_location: true }]],
              resize_keyboard: true, one_time_keyboard: true
            }
          });
          return;
        }

        const ride = await Ride.create({
          riderChatId: chatId,
          pickup: st.pickup,
          destination: st.destination,
          estimate: price,
          vehicleType,
          status: 'payment_pending'
        });

        const payfastRedirect = `${process.env.PUBLIC_URL}/pay/${ride._id}`;
        await riderBot.sendMessage(chatId, '💳 Choose your payment method:', {
          reply_markup: { inline_keyboard: [
            [{ text: '💵 Cash', callback_data: `pay_cash_${ride._id}` }],
            [{ text: '💳 Pay with Card', url: payfastRedirect }]
          ] }
        });

        riderState.set(chatId, { ...st, step: 'awaiting_payment', chosenVehicleType: vehicleType, rideId: String(ride._id) });
        return;
      }

      // CASH chosen → emit rideId + vehicleType so server can assign
      if (data.startsWith('pay_cash_')) {
        const rideId = data.replace('pay_cash_', '');
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        ride.status = 'pending';
        await ride.save();

        // 🔴 FIX: include rideId and vehicleType so server can assign
        const st = riderState.get(chatId);
        const vehicleType = st?.chosenVehicleType || ride.vehicleType;

        // server will take it from here
        riderEvents.emit('booking:new', {
          chatId,
          rideId: String(ride._id),
          vehicleType
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

  riderBot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    const coords = { lat: latitude, lng: longitude };
    await emitRiderLocation(chatId, coords);

    const state = riderState.get(chatId);
    if (!state) return;

    if (state.step === 'awaiting_pickup') {
      state.pickup = coords; state.step = 'awaiting_drop'; riderState.set(chatId, state);
      await riderBot.sendMessage(chatId, '📍 Now send your destination location', {
        reply_markup: {
          keyboard: [[{ text: 'Send Drop 📍', request_location: true }]],
          resize_keyboard: true, one_time_keyboard: true
        }
      });
      return;
    }

    if (state.step === 'awaiting_drop') {
      state.destination = coords; state.step = 'selecting_vehicle';

      // dynamic quotes from nearby drivers
      let quotes = [];
      try {
        quotes = await getAvailableVehicleQuotes({
          pickup: state.pickup,
          destination: state.destination,
          radiusKm: 30
        });
      } catch (e) {
        console.error('getAvailableVehicleQuotes failed:', e);
      }

      if (!quotes.length) {
        state.step = 'awaiting_pickup'; riderState.set(chatId, state);
        await riderBot.sendMessage(chatId, '😞 No drivers are currently available nearby. Please try again.');
        await riderBot.sendMessage(chatId, '📍 Send your pickup location to try again:', {
          reply_markup: {
            keyboard: [[{ text: 'Send Pickup 📍', request_location: true }]],
            resize_keyboard: true, one_time_keyboard: true
          }
        });
        return;
      }

      const toLabel = (vt) => vt === 'comfort' ? 'Comfort' : vt === 'luxury' ? 'Luxury' : vt === 'xl' ? 'XL' : 'Normal';
      const keyboard = quotes.map(q => ([{ text: `${toLabel(q.vehicleType)} — R${q.price}`, callback_data: `veh:${q.vehicleType}:${q.price}` }]));
      state.dynamicQuotes = quotes; riderState.set(chatId, state);

      await riderBot.sendMessage(chatId, '🚘 Select your ride (based on nearby drivers):', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  });

  riderBot.on('edited_message', async (msg) => {
    if (!msg?.location) return;
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location;
    await emitRiderLocation(chatId, { lat: latitude, lng: longitude });
  });
}

export function initRiderBot(io) {
  if (riderBot) { ioRef = io || ioRef; console.log('🤖 Rider bot already initialized'); return riderBot; }
  ioRef = io || null;
  riderBot = new TelegramBot(token, {
    polling: { interval: 300, autoStart: true, params: { timeout: 10, allowed_updates: ['message', 'edited_message', 'callback_query'] } }
  });
  wireRiderHandlers();
  console.log('🤖 Rider bot initialized');
  return riderBot;
}

export { riderBot };
