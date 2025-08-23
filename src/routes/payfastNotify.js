// src/routes/payfastNotify.js
import express from 'express';
import Ride from '../models/Ride.js';
import { riderEvents } from '../bots/riderBot.js';
import { riderBot as RB } from '../bots/riderBot.js';   // <— add this import

const router = express.Router();

/**
 * PayFast IPN (server-to-server).
 * Requires app.use(express.urlencoded({ extended:true })) BEFORE this route.
 */
router.post('/notify', async (req, res) => {
  try {
    const body = req.body || {};
    const rideId = body.m_payment_id || body.partnerId || body.rideId || null;
    if (!rideId) return res.status(400).send('Missing ride ID');

    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).send('Ride not found');

    const status = String(body.payment_status || '').toUpperCase();
    if (!['COMPLETE', 'COMPLETE_PAYMENT', 'PAID'].includes(status)) {
      return res.status(200).send('IGNORED');
    }

    const wasPendingPayment = ride.status === 'payment_pending';

    ride.paymentStatus = 'paid';
    ride.paidAt = new Date();
    ride.paymentMethod = 'payfast';
    if (wasPendingPayment) ride.status = 'pending';
    await ride.save();

    if (wasPendingPayment) {
      // Tell the rider
      try {
        if (ride.riderChatId && RB) {
          await RB.sendMessage(Number(ride.riderChatId), '💳 Payment received! We’re now requesting a driver for you.');
        }
      } catch {}

      // Kick off the normal dispatch
      riderEvents.emit('booking:new', {
        chatId: ride.riderChatId || null,
        rideId: String(ride._id),
        vehicleType: ride.vehicleType || 'normal'
      });
    }

    console.log(`✅ PayFast paid → ride ${ride._id} set to ${ride.status}, dispatching driver`);
    return res.status(200).send('OK');
  } catch (e) {
    console.error('payfast notify error', e);
    return res.status(500).send('ERR');
  }
});

/* Dev helper to simulate success locally */
router.get('/mock-complete/:rideId', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.status(404).send('Ride not found');

    const wasPendingPayment = ride.status === 'payment_pending';
    ride.paymentStatus = 'paid';
    ride.paidAt = new Date();
    ride.paymentMethod = 'payfast';
    if (wasPendingPayment) ride.status = 'pending';
    await ride.save();

    if (wasPendingPayment) {
      riderEvents.emit('booking:new', {
        chatId: ride.riderChatId || null,
        rideId: String(ride._id),
        vehicleType: ride.vehicleType || 'normal'
      });
    }

    return res.send('✅ Mocked PayFast complete. Driver request triggered.');
  } catch (e) {
    console.error(e);
    return res.status(500).send('ERR');
  }
});

export default router;
