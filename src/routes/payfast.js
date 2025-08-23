// src/routes/payfast.js
import express from 'express';
import Ride from '../models/Ride.js';

const router = express.Router();

router.get('/:rideId', async (req, res) => {
  const ride = await Ride.findById(req.params.rideId);
  if (!ride) return res.status(404).send('Ride not found');

  const base = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const url = new URL(`${base}/api/partner/upgrade/payfast`);

  url.searchParams.set('m_payment_id', ride._id.toString());
  url.searchParams.set('partnerId', ride._id.toString());
  url.searchParams.set('plan', ride.vehicleType || 'basic');
  url.searchParams.set('amount', Number(ride.estimate || 0).toFixed(2));
  url.searchParams.set('email', 'user@mail.com');
  url.searchParams.set('companyName', 'TelegramRider');
  url.searchParams.set('contactName', 'Telegram Rider');

  return res.redirect(url.toString());
});

export default router;
