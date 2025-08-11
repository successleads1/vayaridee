const express = require('express');
const Ride = require('../models/Ride');
const crypto = require('crypto');

const router = express.Router();

router.post('/notify', async (req, res) => {
  const data = req.body;
  const rideId = data.m_payment_id;

  if (!rideId) return res.status(400).send('Missing ride ID');

  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).send('Ride not found');

    if (data.payment_status === 'COMPLETE') {
      ride.paymentStatus = 'paid';
      await ride.save();
      console.log(`✅ Ride ${rideId} marked as paid`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

module.exports = router;
