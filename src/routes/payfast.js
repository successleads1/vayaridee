import express from 'express';
import Ride from '../models/Ride.js';

const router = express.Router();

router.get('/:rideId', async (req, res) => {
  const ride = await Ride.findById(req.params.rideId);
  if (!ride) return res.status(404).send('Ride not found');

  const payfastRedirectUrl = new URL('https://www.explore-capetown.co.za/api/partner/upgrade/payfast');
  payfastRedirectUrl.searchParams.append('partnerId', ride._id.toString());
  payfastRedirectUrl.searchParams.append('plan', ride.vehicleType || 'basic');
  payfastRedirectUrl.searchParams.append('amount', ride.estimate.toFixed(2));
  payfastRedirectUrl.searchParams.append('email', 'user@mail.com'); // Replace dynamically if needed
  payfastRedirectUrl.searchParams.append('companyName', 'TelegramRider');
  payfastRedirectUrl.searchParams.append('contactName', 'Telegram Rider');

  return res.redirect(payfastRedirectUrl.toString());
});

export default router;
