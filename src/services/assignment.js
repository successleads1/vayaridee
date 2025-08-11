// src/services/assignment.js
import Driver from '../models/Driver.js';
import Ride from '../models/Ride.js';
import { kmBetween, estimatePrice } from './pricing.js';

/** Ensure driver has a numeric chatId so Telegram can DM them */
function hasNumericChatId(driver) {
  return driver && typeof driver.chatId !== 'undefined' && !Number.isNaN(Number(driver.chatId));
}

/**
 * Choose the nearest driver who is:
 *  - approved
 *  - ONLINE (isAvailable: true)
 *  - has numeric chatId (linked to Telegram)
 *  - has a last known location
 * You can exclude driver IDs (or chatIds) with the `exclude` array.
 */
export async function assignNearestDriver(pickup, exclude = []) {
  const q = {
    status: 'approved',
    isAvailable: true,
    chatId: { $type: 'number' },
    'location.lat': { $exists: true },
    'location.lng': { $exists: true }
  };

  if (exclude?.length) {
    q._id = { $nin: exclude };
  }

  const drivers = await Driver.find(q).lean();

  if (!drivers.length) {
    console.log('❌ No eligible (online + linked) drivers with location');
    return null;
  }

  console.log(`📍 Found ${drivers.length} eligible driver(s) with location`);

  const withDist = drivers
    .map((d) => ({
      ...d,
      distance: kmBetween(d.location, pickup)
    }))
    .sort((a, b) => a.distance - b.distance);

  const chosen = withDist[0];
  console.log(
    `✅ Nearest driver: ${chosen.name || chosen.email || chosen._id} (${chosen.distance.toFixed(2)} km away)`
  );

  // Return full mongoose document (not lean) in case callers want to mutate
  const driverDoc = await Driver.findById(chosen._id);
  return driverDoc;
}

/**
 * Update a ride's estimate using the configured pricing table.
 * `vehicleType` defaults to 'normal' if not provided on the ride.
 */
export async function setEstimateOnRide(rideId, driverLocation = null) {
  const ride = await Ride.findById(rideId);
  if (!ride) return null;

  const vehicleType = ride.vehicleType || 'normal';
  const { price } = estimatePrice({
    pickup: ride.pickup,
    destination: ride.destination,
    driverLocation,
    vehicleType
  });

  ride.estimate = price;
  await ride.save();
  return price;
}

export { hasNumericChatId };
