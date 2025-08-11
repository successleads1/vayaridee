// src/bots/driverBot.js
import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import Driver from '../models/Driver.js';
import Ride from '../models/Ride.js';

export const driverEvents = new EventEmitter();

// singletons
let bot = null;
let ioRef = null;

// utils
const toNum = (v) => (v == null ? v : Number(v));

function onlineKeyboard(isOnline) {
  return {
    reply_markup: {
      inline_keyboard: [[
        isOnline
          ? { text: '🔴 Go Offline', callback_data: 'drv_offline' }
          : { text: '🟢 Go Online', callback_data: 'drv_online' }
      ]]
    }
  };
}

function locationKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: 'Send Live Location 📍', request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

async function setAvailability(chatId, isOnline) {
  const driver = await Driver.findOneAndUpdate(
    { chatId: Number(chatId) },
    { $set: { isAvailable: !!isOnline } },
    { new: true }
  );
  return driver;
}

async function getOrLinkDriverByChat(msg) {
  const chatId = toNum(msg.chat.id);
  let driver = await Driver.findOne({ chatId });

  if (!driver) {
    const tgUsername = msg.from?.username;
    if (tgUsername) {
      driver = await Driver.findOneAndUpdate(
        {
          telegramUsername: tgUsername,
          $or: [{ chatId: { $exists: false } }, { chatId: null }]
        },
        { $set: { chatId } },
        { new: true }
      );
    }
  }
  return driver;
}

async function linkDriverByEmail(email, msg) {
  const chatId = toNum(msg.chat.id);
  const tgUsername = msg.from?.username || null;

  const emailRegex = new RegExp(
    `^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'i'
  );

  await Driver.updateMany({ chatId }, { $unset: { chatId: '' } });

  const driver = await Driver.findOneAndUpdate(
    { email: emailRegex },
    { $set: { chatId, telegramUsername: tgUsername } },
    { new: true }
  );

  return driver;
}

// DM "approved"
async function sendApprovalNoticeInternal(chatId) {
  await bot.sendMessage(
    chatId,
    "🎉 You're approved as a VayaRide driver!\n\nTap below to go online when you're ready to accept trips.",
    onlineKeyboard(false)
  );
}

// common inline controls shown after a driver ACCEPTs
function tripControls(rideId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📍 Arrived at Pickup', callback_data: `arrived_${rideId}` }
        ],
        [
          { text: '▶️ Start Trip', callback_data: `start_${rideId}` }
        ],
        [
          { text: '❌ Cancel Ride', callback_data: `cancel_${rideId}` }
        ]
      ]
    }
  };
}

export function initDriverBot(io) {
  if (bot) {
    ioRef = io || ioRef;
    console.log('🚗 Driver bot already initialized');
    return bot;
  }

  const token = process.env.TELEGRAM_DRIVER_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_DRIVER_BOT_TOKEN is not defined in .env');

  ioRef = io || null;
  bot = new TelegramBot(token, {
    polling: {
      interval: 300,
      autoStart: true,
      params: {
        timeout: 10,
        allowed_updates: ['message', 'edited_message', 'callback_query']
      }
    }
  });

  const pendingCancellations = new Map();

  // expose approval helper
  bot.sendApprovalNotice = sendApprovalNoticeInternal;

  /* ---------------- /start ---------------- */
  bot.onText(/\/start/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    let driver = await getOrLinkDriverByChat(msg);

    if (!driver) {
      await bot.sendMessage(
        chatId,
        "🚨 I couldn't find your driver profile by chat. If you've already registered on the website, link your account by sending:\n\n" +
          'LINK your@email.com'
      );
      return;
    }

    if (driver.status !== 'approved') {
      await bot.sendMessage(
        chatId,
        '⏳ Your account is pending admin approval. You will get a message here when approved.'
      );
      return;
    }

    const isOnline = !!driver.isAvailable;
    await bot.sendMessage(
      chatId,
      isOnline
        ? '✅ You are currently ONLINE. You will receive ride requests.'
        : '⏸ You are currently OFFLINE.',
      onlineKeyboard(isOnline)
    );

    await bot.sendMessage(
      chatId,
      'When ONLINE, share your **live location** so riders can be matched to you.',
      { parse_mode: 'Markdown' }
    );
    await bot.sendMessage(chatId, 'Tap below to send your location:', locationKeyboard());
  });

  /* ------------- LINK <email> ------------- */
  bot.onText(/^LINK\s+(\S+@\S+\.\S+)$/i, async (msg, match) => {
    const chatId = toNum(msg.chat.id);
    const email = (match[1] || '').trim();

    try {
      const driver = await linkDriverByEmail(email, msg);

      if (!driver) {
        await bot.sendMessage(
          chatId,
          "❌ Couldn't find a driver with that email. Double-check the email you used on the website."
        );
        return;
      }

      await bot.sendMessage(chatId, `🔗 Linked your Telegram to ${driver.email}.`);

      if (driver.status !== 'approved') {
        await bot.sendMessage(
          chatId,
          '⏳ Your account is pending admin approval. You will get a message here when approved.'
        );
        return;
      }

      const isOnline = !!driver.isAvailable;
      await bot.sendMessage(
        chatId,
        isOnline
          ? '✅ You are currently ONLINE. You will receive ride requests.'
          : '⏸ You are currently OFFLINE.',
        onlineKeyboard(isOnline)
      );
      await bot.sendMessage(chatId, 'Tap below to send your location:', locationKeyboard());
    } catch (e) {
      console.error('LINK handler error:', e);
      await bot.sendMessage(chatId, '⚠️ Failed to link. Please try again in a moment.');
    }
  });

  /* ---------- convenience text commands ---------- */
  bot.onText(/^\/whoami$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await Driver.findOne({ chatId }).lean();
    if (!driver) {
      await bot.sendMessage(
        chatId,
        "I don't see your driver profile yet. Try `LINK your@email.com`."
      );
      return;
    }
    await bot.sendMessage(
      chatId,
      `You are:
• email: ${driver.email || '-'}
• name: ${driver.name || '-'}
• status: ${driver.status}
• online: ${driver.isAvailable ? 'yes' : 'no'}
• chatId: ${driver.chatId}`
    );
  });

  bot.onText(/^\/online$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await setAvailability(chatId, true);
    if (!driver) {
      await bot.sendMessage(chatId, '❌ Driver profile not found.');
      return;
    }
    await bot.sendMessage(
      chatId,
      '🟢 You are now ONLINE. You will receive ride requests.',
      onlineKeyboard(true)
    );
    await bot.sendMessage(chatId, 'Send your live location:', locationKeyboard());
  });

  bot.onText(/^\/offline$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await setAvailability(chatId, false);
    if (!driver) {
      await bot.sendMessage(chatId, '❌ Driver profile not found.');
      return;
    }
    await bot.sendMessage(
      chatId,
      '🔴 You are now OFFLINE.',
      onlineKeyboard(false)
    );
  });

  // quick helper command to pop the location keyboard
  bot.onText(/^\/loc$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    await bot.sendMessage(chatId, 'Tap below to send your location:', locationKeyboard());
  });

  /* ---------------- location ---------------- */
  bot.on('message', async (msg) => {
    if (!msg?.location) return;
    const chatId = toNum(msg.chat.id);
    const { latitude, longitude } = msg.location || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    // Persist latest location + mark online
    await Driver.findOneAndUpdate(
      { chatId },
      {
        $set: {
          location: { lat: latitude, lng: longitude },
          lastSeenAt: new Date(),
          isAvailable: true
        }
      },
      { new: true }
    );

    // Emit for maps/clients
    driverEvents.emit('driver:location', {
      chatId,
      driverId: chatId,
      location: { lat: latitude, lng: longitude }
    });

    // Tiny acknowledgement
    try { await bot.sendMessage(chatId, '📍 Location updated. Thanks!'); } catch {}
  });

  /* LIVE location edits from Telegram (driver live location keeps moving) */
  bot.on('edited_message', async (msg) => {
    if (!msg?.location) return;
    const chatId = Number(msg.chat.id);
    const { latitude, longitude } = msg.location;

    await Driver.findOneAndUpdate(
      { chatId },
      {
        $set: {
          location: { lat: latitude, lng: longitude },
          lastSeenAt: new Date(),
          isAvailable: true
        }
      }
    );

    driverEvents.emit('driver:location', {
      chatId,
      driverId: chatId,
      location: { lat: latitude, lng: longitude }
    });
  });

  /* ------------- inline button actions -------------- */
  bot.on('callback_query', async (query) => {
    const chatId = toNum(query.message.chat.id);
    const data = query.data;

    try {
      // availability toggles
      if (data === 'drv_online') {
        const driver = await setAvailability(chatId, true);
        await bot.answerCallbackQuery({ callback_query_id: query.id });
        if (!driver) {
          await bot.sendMessage(chatId, '❌ Driver profile not found.');
          return;
        }
        await bot.editMessageText(
          '🟢 You are now ONLINE. You will receive ride requests.',
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            ...onlineKeyboard(true)
          }
        );
        await bot.sendMessage(chatId, 'Send your live location:', locationKeyboard());
        return;
      }

      if (data === 'drv_offline') {
        const driver = await setAvailability(chatId, false);
        await bot.answerCallbackQuery({ callback_query_id: query.id });
        if (!driver) {
          await bot.sendMessage(chatId, '❌ Driver profile not found.');
          return;
        }
        await bot.editMessageText('🔴 You are now OFFLINE.', {
          chat_id: chatId,
          message_id: query.message.message_id,
          ...onlineKeyboard(false)
        });
        return;
      }

      // ride actions: ACCEPT/IGNORE from the offer
      if (data.startsWith('accept_')) {
        const rideId = data.replace('accept_', '');
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        // store accepting driver on ride
        const driver = await Driver.findOne({ chatId });
        if (driver) ride.driverId = driver._id;

        ride.status = 'accepted';
        await ride.save();

        await bot.sendMessage(chatId, '✅ You accepted the ride.', tripControls(rideId));
        driverEvents.emit('ride:accepted', { driverId: chatId, rideId });

        return;
      }

      if (data.startsWith('ignore_')) {
        const rideId = data.replace('ignore_', '');
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        ride.driverId = null;
        ride.status = 'pending';
        await ride.save();
        await bot.sendMessage(chatId, '❌ You ignored the ride.');
        driverEvents.emit('ride:ignored', { previousDriverId: chatId, ride });
        return;
      }

      // new: arrived at pickup
      if (data.startsWith('arrived_')) {
        const rideId = data.replace('arrived_', '');
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        await bot.answerCallbackQuery({ callback_query_id: query.id, text: 'Marked arrived' });
        await bot.sendMessage(chatId, '📍 Marked as arrived at pickup.', tripControls(rideId));

        // server will notify rider
        driverEvents.emit('ride:arrived', { driverId: chatId, rideId });
        return;
      }

      // new: start trip (set status → enroute)
      if (data.startsWith('start_')) {
        const rideId = data.replace('start_', '');
        const ride = await Ride.findById(rideId);
        if (!ride) return;

        ride.status = 'enroute';
        await ride.save();

        await bot.answerCallbackQuery({ callback_query_id: query.id, text: 'Trip started' });
        await bot.sendMessage(chatId, '▶️ Trip started.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Cancel Ride', callback_data: `cancel_${rideId}` }]
            ]
          }
        });

        // server will notify rider
        driverEvents.emit('ride:started', { driverId: chatId, rideId });
        return;
      }

      // cancel flow (with reasons)
      if (data.startsWith('cancel_')) {
        const rideId = data.replace('cancel_', '');
        const ride = await Ride.findById(rideId);
        if (!ride || (ride.status !== 'accepted' && ride.status !== 'enroute')) {
          await bot.sendMessage(chatId, '🚫 No active ride to cancel.');
          return;
        }

        pendingCancellations.set(chatId, rideId);
        await bot.sendMessage(chatId, '❓ Why are you cancelling?', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚦 Traffic or Delays', callback_data: 'reason_traffic' }],
              [{ text: '🛠 Car Trouble', callback_data: 'reason_car' }],
              [{ text: '👤 Personal Emergency', callback_data: 'reason_emergency' }],
              [{ text: '🚫 Rider unreachable', callback_data: 'reason_rider' }]
            ]
          }
        });
        return;
      }

      if (data.startsWith('reason_')) {
        const reasonMap = {
          reason_traffic: 'Traffic or unexpected delay',
          reason_car: 'Car trouble',
          reason_emergency: 'Personal emergency',
          reason_rider: 'Rider unreachable'
        };

        const reason = reasonMap[data];
        const rideId = pendingCancellations.get(chatId);
        if (!rideId || !reason) return;

        const ride = await Ride.findById(rideId);
        if (!ride) return;

        ride.status = 'cancelled';
        ride.cancelReason = reason;
        await ride.save();

        driverEvents.emit('ride:cancelled', { ride, reason });

        await bot.sendMessage(chatId, '✅ Ride cancelled.');
        pendingCancellations.delete(chatId);
        return;
      }
    } catch (err) {
      console.error('driver callback_query error:', err);
      try {
        await bot.answerCallbackQuery({
          callback_query_id: query.id,
          text: '⚠️ Error. Please try again.',
          show_alert: false
        });
      } catch {}
    }
  });

  console.log('🚗 Driver bot initialized');
  return bot;
}

// helper you can call from admin route (or anywhere)
export async function sendApprovalNotice(chatId) {
  if (!bot) throw new Error('Driver bot not initialized. Call initDriverBot(io) first.');
  if (chatId == null) {
    console.warn('⚠️ sendApprovalNotice called without chatId');
    return;
  }
  try {
    await sendApprovalNoticeInternal(chatId);
  } catch (err) {
    console.error('Error sending Telegram approval notice:', err?.message || err);
  }
}

export { bot as driverBot };
