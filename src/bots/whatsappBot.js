// src/bots/whatsappBot.js
import pkg from '@whiskeysockets/baileys';
const {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  delay
} = pkg;

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode';
import EventEmitter from 'events';
import axios from 'axios';

import Ride from '../models/Ride.js';
import { riderEvents } from './riderBot.js';
import { driverEvents } from './driverBot.js';
import { getAvailableVehicleQuotes } from '../services/pricing.js';

/* --------------- paths / env --------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(process.cwd());
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const AUTH_DIR = path.resolve(ROOT_DIR, 'baileys_auth_info');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/* --------------- state --------------- */
let sock = null;
let initializing = false;
let currentQR = null;
let connState = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'

// WA rider name (simple in-memory profile)
const waNames = new Map(); // jid -> name
// rideId -> riderJid (so we can DM rider on accept/arrive/start/cancel)
const waRideById = new Map();

// per-JID booking wizard state
// { stage, pickup, destination, quotes, chosenVehicle, price, rideId, suggestions, addrSession }
const convo = new Map();

/**
 * stages:
 * - idle
 * - await_pickup
 * - await_destination
 * - await_vehicle
 * - await_payment
 */

const VEHICLE_LABEL = (vt) =>
  vt === 'comfort' ? 'Comfort' : vt === 'luxury' ? 'Luxury' : vt === 'xl' ? 'XL' : 'Normal';

// QR broadcast for server route /qrcode
const waEvents = new EventEmitter();

/* --------------- logger --------------- */
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

/* --------------- helpers --------------- */
function purgeAuthFolder() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    for (const f of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
    }
    logger.warn('WA: purged auth folder');
  } catch (e) {
    logger.error('WA: purge error %s', e?.message || e);
  }
}

async function saveQrPng(dataUrl) {
  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const file = path.join(PUBLIC_DIR, 'wa-qr.png');
    fs.writeFileSync(file, base64, 'base64');
  } catch (e) {
    logger.warn('WA: failed to save wa-qr.png: %s', e?.message || e);
  }
}

/* ---------- DEDUPE LAYER (prevents double-sends) ---------- */
const DEDUPE_TTL_MS = Number(process.env.WA_DEDUPE_TTL_MS || 12000);
const _recentSends = new Map(); // key `${jid}|${normText}` -> timestamp

function _normalizeText(t = '') {
  // normalize whitespace; keep content & link intact
  return String(t).trim().replace(/\s+/g, ' ');
}
function _shouldSendOnce(jid, text) {
  const key = `${jid}|${_normalizeText(text)}`;
  const now = Date.now();
  const last = _recentSends.get(key) || 0;
  if (now - last < DEDUPE_TTL_MS) return false;
  _recentSends.set(key, now);
  // light pruning to keep map small
  if (_recentSends.size > 2000) {
    const cutoff = now - 2 * DEDUPE_TTL_MS;
    for (const [k, ts] of _recentSends) {
      if (ts < cutoff) _recentSends.delete(k);
    }
  }
  return true;
}

async function sendText(jid, text) {
  if (!sock) throw new Error('WA client not ready');
  if (!_shouldSendOnce(jid, text)) {
    logger.debug?.('WA dedupe: skipped duplicate to %s: %s', jid, _normalizeText(text).slice(0, 80));
    return;
  }
  // link previews disabled globally in socket options below
  await sock.sendMessage(jid, { text });
}

function resetFlow(jid) {
  convo.set(jid, { stage: 'idle' });
}

function startBooking(jid) {
  convo.set(jid, { stage: 'await_pickup' });
}

function sendMainMenu(jid) {
  return sendText(
    jid,
    `👋 *Welcome to VayaRide!*\n` +
    `Please reply with a number:\n\n` +
    `1) 🚕 Book Trip\n` +
    `2) ❓ Help\n` +
    `3) 🧑‍💬 Support`
  );
}

/* ---------- Google Places helpers (autocomplete + details) ---------- */
function ensureSessionToken(state) {
  if (!state.addrSession) state.addrSession = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return state.addrSession;
}

async function placesAutocomplete(input, sessionToken) {
  if (!GOOGLE_MAPS_API_KEY) return [];
  const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
  const params = {
    input,
    key: GOOGLE_MAPS_API_KEY,
    sessiontoken: sessionToken,
    // components: 'country:za', // uncomment to restrict
  };
  const { data } = await axios.get(url, { params, timeout: 10000 });
  if (data?.status !== 'OK' || !Array.isArray(data?.predictions)) return [];
  return data.predictions.slice(0, 5).map(p => ({ place_id: p.place_id, description: p.description }));
}

async function placeDetails(placeId, sessionToken) {
  if (!GOOGLE_MAPS_API_KEY) return null;
  const url = 'https://maps.googleapis.com/maps/api/place/details/json';
  const params = {
    place_id: placeId,
    fields: 'geometry/location,formatted_address,name',
    key: GOOGLE_MAPS_API_KEY,
    sessiontoken: sessionToken
  };
  const { data } = await axios.get(url, { params, timeout: 10000 });
  if (data?.status !== 'OK' || !data?.result?.geometry?.location) return null;
  const loc = data.result.geometry.location;
  return {
    lat: Number(loc.lat),
    lng: Number(loc.lng),
    address: data.result.formatted_address || data.result.name || ''
  };
}

function formatSuggestionList(sugs) {
  if (!sugs?.length) return '';
  return sugs.map((s, i) => `${i + 1}) ${s.description}`).join('\n');
}

/* --------------- WA setup --------------- */
async function setupClient() {
  if (initializing) return;
  initializing = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);
    console.log('🔄 Connecting to WhatsApp...');

    connState = 'connecting';

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ['VayaRide Bot', 'Chrome', '120.0'],
      generateHighQualityLinkPreview: false, // 🔕 avoid link-preview-js dependency/noise
      qrTimeout: 60_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 10_000,
      markOnlineOnConnect: true,
      syncFullHistory: false
    });

    // persist creds
    sock.ev.on('creds.update', saveCreds);

    // connection lifecycle
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        try {
          const term = await qrcode.toString(qr, { type: 'terminal', small: true });
          console.log('\n' + term);
        } catch {
          console.log('Open /qrcode to scan via browser.');
        }
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          await saveQrPng(dataUrl);
          waEvents.emit('qr', dataUrl);
        } catch (e) {
          logger.warn('WA: could not create QR dataURL: %s', e?.message || e);
        }
      }

      if (connection === 'open') {
        currentQR = null;
        connState = 'connected';
        console.log('✅ WhatsApp connected');
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.status ??
          0;
        const reason = lastDisconnect?.error?.data?.reason;
        console.log('WA connection closed →', code, reason);

        const isLoggedOut =
          code === DisconnectReason.loggedOut ||
          code === 401 ||
          reason === '401' ||
          reason === 'logged_out';

        const badSession =
          code === DisconnectReason.badSession ||
          reason === 'bad_session';

        connState = 'disconnected';

        if (isLoggedOut || badSession) {
          console.log('❌ Logged out / bad session. Clearing creds and restarting…');
          purgeAuthFolder();
          await delay(1500);
          initializing = false;
          return setupClient();
        }

        console.log('↩️ Reconnecting in 5s…');
        await delay(5000);
        initializing = false;
        return setupClient();
      }
    });

    // inbound messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages || []) {
        try {
          // ignore ourselves & status
          const fromMe = m.key?.fromMe;
          const jid = m.key?.remoteJid;
          if (fromMe || jid === 'status@broadcast') continue;

          const msg = m.message || {};

          // ignore non-conversational/system-ish messages completely
          if (
            msg.protocolMessage ||
            msg.reactionMessage ||
            msg.pollUpdateMessage ||
            msg.pollCreationMessage ||
            msg.ephemeralMessage ||
            msg.viewOnceMessage ||
            msg.viewOnceMessageV2
          ) {
            continue;
          }

          const loc = msg.locationMessage || null;
          let text =
            msg.conversation ||
            msg.extendedTextMessage?.text ||
            msg.imageMessage?.caption ||
            msg.videoMessage?.caption ||
            '';

          text = (text || '').trim();

          // If there's neither a location nor any user text, do nothing
          if (!loc && !text) continue;

          if (loc) {
            await handleLocationMessage(jid, loc);
            continue;
          }

          await handleTextMessage(jid, text);
        } catch (e) {
          console.error('WA handle error:', e);
          try { await sendText(m.key.remoteJid, 'Sorry, something went wrong. Try again.'); } catch {}
        }
      }
    });

  } catch (err) {
    console.error('❌ Error setting up WA client:', err);
  } finally {
    initializing = false;
  }
}

/* --------------- message handlers --------------- */
async function handleTextMessage(jid, raw) {
  if (!raw) return; // ignore empty text
  const txt = (raw || '').toLowerCase();
  const state = convo.get(jid) || { stage: 'idle' };

  /* ======= GLOBAL ENTRY / MENU ======= */
  if (txt === '/start' || txt === 'start' || txt === 'hi' || txt === 'hello' || txt === 'menu') {
    resetFlow(jid);
    await sendMainMenu(jid);
    return;
  }

  // Menu selection is only valid when idle (avoid clashing with 1/2 in other stages)
  if ((state.stage || 'idle') === 'idle') {
    if (txt === '1' || txt === 'book' || txt === 'book trip') {
      startBooking(jid);
      await sendText(jid, `📍 Send your *pickup* — share location (📎 → Location) *or type the address* and I’ll suggest matches.`);
      return;
    }
    if (txt === '2' || txt === 'help' || txt === '/help') {
      await sendText(
        jid,
        `🤖 *How to book*\n` +
        `• Send pickup: share location (📎) *or type an address*\n` +
        `• Send destination the same way\n` +
        `• Choose vehicle → choose payment (cash/card)\n\n` +
        `Reply *menu* anytime to see options.`
      );
      return;
    }
    if (txt === '3' || txt === 'support') {
      await sendText(jid, `🧑‍💬 *Support*\nMessage us here or reach our Telegram help desk: https://t.me/yourSupportBot`);
      return;
    }
  }

  /* ======= OPTIONAL: LIGHTWEIGHT NAME CAPTURE (non-blocking) ======= */
  if (!waNames.has(jid) && /^[a-z][a-z\s.'-]{1,}$/i.test(raw.trim())) {
    waNames.set(jid, raw.trim());
    await sendText(jid, `✅ Nice to meet you, ${raw.trim()}!\nType *menu* to see options, or just *1* to book.`);
    return;
  }

  /* ======= ADDRESS / BOOKING FLOW ======= */

  // PICKUP: select from suggestions by number
  if (state.stage === 'await_pickup' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) {
      await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.');
      return;
    }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.pickup = { lat: det.lat, lng: det.lng };
      state.suggestions = [];
      state.stage = 'await_destination';
      convo.set(jid, state);
      await sendText(jid, `✅ Pickup set to: ${det.address}\n\n📍 Now send your *destination* — share location (📎) or type address for suggestions.`);
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the pickup address again.');
      return;
    }
  }

  // PICKUP: typed query → suggestions
  if (state.stage === 'await_pickup' && raw.length >= 3) {
    if (!GOOGLE_MAPS_API_KEY) {
      await sendText(jid, '⚠️ Address search unavailable. Please share your pickup using the 📎 attachment.');
      return;
    }
    try {
      const sessionToken = ensureSessionToken(state);
      const sugs = await placesAutocomplete(raw, sessionToken);
      if (!sugs.length) {
        await sendText(jid, 'No matches found. Try another address, or share your location (📎).');
        return;
      }
      state.suggestions = sugs;
      convo.set(jid, state);
      await sendText(jid, '📍 *Pickup suggestions:*\n' + formatSuggestionList(sugs) + '\n\nReply with the *number* of your choice or type a new address.');
      return;
    } catch {
      await sendText(jid, '⚠️ Address search failed. Please try again or share your location (📎).');
      return;
    }
  }

  // DESTINATION: select from suggestions by number
  if (state.stage === 'await_destination' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) {
      await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.');
      return;
    }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.destination = { lat: det.lat, lng: det.lng };
      state.suggestions = [];

      // quotes
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
        state.stage = 'await_pickup';
        convo.set(jid, state);
        await sendText(jid, '😞 No drivers are currently available nearby. Please try again shortly.');
        await sendText(jid, '📍 Send your pickup again — share location (📎) or type address.');
        return;
      }
      state.quotes = quotes;
      state.stage = 'await_vehicle';
      convo.set(jid, state);

      const lines = quotes.map((q, i) => `${i + 1}) ${VEHICLE_LABEL(q.vehicleType)} — R${q.price}`);
      await sendText(jid, '🚘 Select your ride:\n' + lines.join('\n') + '\n\nReply with the *number* of your choice.');
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the destination address again.');
      return;
    }
  }

  // DESTINATION: typed query → suggestions
  if (state.stage === 'await_destination' && raw.length >= 3) {
    if (!GOOGLE_MAPS_API_KEY) {
      await sendText(jid, '⚠️ Address search unavailable. Please share your destination using the 📎 attachment.');
      return;
    }
    try {
      const sessionToken = ensureSessionToken(state);
      const sugs = await placesAutocomplete(raw, sessionToken);
      if (!sugs.length) {
        await sendText(jid, 'No matches found. Try another address, or share your location (📎).');
        return;
      }
      state.suggestions = sugs;
      convo.set(jid, state);
      await sendText(jid, '📍 *Destination suggestions:*\n' + formatSuggestionList(sugs) + '\n\nReply with the *number* of your choice or type a new address.');
      return;
    } catch {
      await sendText(jid, '⚠️ Address search failed. Please try again or share your location (📎).');
      return;
    }
  }

  // VEHICLE selection (1..N)
  if (state.stage === 'await_vehicle' && /^\d{1,2}$/.test(txt)) {
    const idx = Number(txt) - 1;
    const q = state.quotes?.[idx];
    if (!q) {
      await sendText(jid, '⚠️ Invalid choice. Reply with a valid number from the list.');
      return;
    }
    state.chosenVehicle = q.vehicleType;
    state.price = q.price;

    // Create Ride (payment pending) and keep rider JID for notifications
    const ride = await Ride.create({
      pickup: state.pickup,
      destination: state.destination,
      estimate: q.price,
      paymentMethod: 'cash',        // default; may change in payment step
      vehicleType: q.vehicleType,
      status: 'payment_pending',
      platform: 'whatsapp',
      riderWaJid: jid
    });

    waRideById.set(String(ride._id), jid);
    state.rideId = String(ride._id);
    state.stage = 'await_payment';
    convo.set(jid, state);

    const summary =
      `🧾 *Trip Summary*\n` +
      `• Vehicle: ${VEHICLE_LABEL(q.vehicleType)}\n` +
      `• Estimate: R${q.price}\n` +
      `• Pickup: (${state.pickup.lat.toFixed(5)}, ${state.pickup.lng.toFixed(5)})\n` +
      `• Drop:   (${state.destination.lat.toFixed(5)}, ${state.destination.lng.toFixed(5)})\n\n` +
      `Choose payment:\n` +
      `1) 💵 Cash\n` +
      `2) 💳 Card (PayFast)\n` +
      `Reply with *1* or *2*.`;

    await sendText(jid, summary);
    return;
  }

  // PAYMENT selection
  if (state.stage === 'await_payment') {
    if (txt === '1' || txt === 'cash') {
      const ride = await Ride.findById(state.rideId);
      if (!ride) {
        resetFlow(jid);
        await sendText(jid, '⚠️ Session expired. Type *menu* → *1* to start again.');
        return;
      }
      ride.paymentMethod = 'cash';
      ride.status = 'pending';
      await ride.save();

      riderEvents.emit('booking:new', {
        rideId: String(ride._id),
        vehicleType: state.chosenVehicle
      });

      await sendText(jid, '✅ Cash selected. Requesting the nearest driver for you…');
      resetFlow(jid);
      return;
    }

    if (txt === '2' || txt === 'card' || txt === 'payfast') {
      const rideId = state.rideId;
      if (!rideId) {
        resetFlow(jid);
        await sendText(jid, '⚠️ Session expired. Type *menu* → *1* to start again.');
        return;
      }
      const link = `${process.env.PUBLIC_URL}/pay/${encodeURIComponent(rideId)}`;
      await sendText(jid, `💳 Pay with card here:\n${link}\n\nAfter payment, we’ll notify a driver.`);
      resetFlow(jid);
      return;
    }

    await sendText(jid, 'Reply with *1* for Cash or *2* for Card.');
    return;
  }

  // If nothing else matched and we’re mid-flow, give a contextual hint.
  if (state.stage === 'await_pickup') {
    await sendText(jid, `📍 Please send your *pickup* — share location (📎) or type the address for suggestions.`);
    return;
  }
  if (state.stage === 'await_destination') {
    await sendText(jid, `📍 Please send your *destination* — share location (📎) or type the address for suggestions.`);
    return;
  }

  // Idle fallback
  if ((convo.get(jid)?.stage || 'idle') === 'idle') {
    await sendMainMenu(jid);
  }
}

async function handleLocationMessage(jid, locationMessage) {
  const lat = locationMessage.degreesLatitude;
  const lng = locationMessage.degreesLongitude;

  const state = convo.get(jid) || { stage: 'idle' };

  // if not in flow, start and treat as pickup
  if (state.stage === 'idle') {
    startBooking(jid);
    state.stage = 'await_pickup';
  }

  if (state.stage === 'await_pickup') {
    state.pickup = { lat, lng };
    state.suggestions = [];
    state.stage = 'await_destination';
    convo.set(jid, state);
    await sendText(jid, '✅ Pickup saved.\n\n📍 Now send your *destination* — share location (📎) or type address for suggestions.');
    return;
  }

  if (state.stage === 'await_destination') {
    state.destination = { lat, lng };
    state.suggestions = [];

    // quotes
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
      state.stage = 'await_pickup';
      convo.set(jid, state);
      await sendText(jid, '😞 No drivers are currently available nearby. Please try again shortly.');
      await sendText(jid, '📍 Send your pickup again — share location (📎) or type address.');
      return;
    }

    state.quotes = quotes;
    state.stage = 'await_vehicle';
    convo.set(jid, state);

    const lines = quotes.map((q, i) => `${i + 1}) ${VEHICLE_LABEL(q.vehicleType)} — R${q.price}`);
    await sendText(jid, '🚘 Select your ride:\n' + lines.join('\n') + '\n\nReply with the *number* of your choice.');
    return;
  }
}

/* --------------- Telegram driver → WA rider notifications --------------- */
driverEvents.on('ride:accepted', async ({ rideId }) => {
  const jid = waRideById.get(String(rideId));
  if (!jid) return;
  const link = `${process.env.PUBLIC_URL}/track.html?rideId=${encodeURIComponent(rideId)}`;
  try { await sendText(jid, `🚗 Your ride is on the way. Track here:\n${link}`); } catch {}
});

driverEvents.on('ride:arrived', async ({ rideId }) => {
  const jid = waRideById.get(String(rideId));
  if (!jid) return;
  try { await sendText(jid, '📍 Your driver has arrived at the pickup point.'); } catch {}
});

driverEvents.on('ride:started', async ({ rideId }) => {
  const jid = waRideById.get(String(rideId));
  if (!jid) return;
  try { await sendText(jid, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
});

driverEvents.on('ride:cancelled', async ({ ride }) => {
  const jid = ride ? waRideById.get(String(ride._id)) : null;
  if (!jid) return;
  try { await sendText(jid, '❌ The driver cancelled the trip. Please try booking again.'); } catch {}
});

/* ------------ public API ------------ */
export function initWhatsappBot() {
  if (sock || initializing) {
    console.log('WhatsApp Bot already initialized');
    return;
  }
  console.log('🚀 Initializing WhatsApp Bot...');
  setupClient();
}

export function isWhatsAppConnected() {
  return !!(sock && sock.ws && sock.ws.readyState === 1);
}

export function getConnectionStatus() {
  return connState;
}

/** Wait for a QR (or return the cached one) and give back a data: URL */
export async function waitForQrDataUrl(timeoutMs = 25000) {
  if (currentQR) return qrcode.toDataURL(currentQR);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for QR')), timeoutMs);
    waEvents.once('qr', (dataUrl) => {
      clearTimeout(t);
      resolve(dataUrl);
    });
  });
}

export async function sendWhatsAppMessage(jid, text) {
  return sendText(jid, text);
}

export async function resetWhatsAppSession() {
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
      try { sock.end?.(); } catch {}
      sock = null;
    }
    purgeAuthFolder();
    currentQR = null;
    connState = 'disconnected';
  } finally {
    setupClient();
  }
}
