// src/services/pricing.js

/** Great-circle distance (Haversine) in KM */
export function kmBetween(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Pricing tables
 * - normal:   perKm 7,  min 30, within 30 km
 * - comfort:  perKm 8,  min 30, within 30 km
 * - luxury:   perKm 12, min 45, within 45 km
 * - xl:       perKm 10, min 39, within 40 km
 */
const RATE_TABLE = {
  normal:  { perKm: 7,  minCharge: 30, withinKm: 30 },
  comfort: { perKm: 8,  minCharge: 30, withinKm: 30 },
  luxury:  { perKm: 12, minCharge: 45, withinKm: 45 },
  xl:      { perKm: 10, minCharge: 39, withinKm: 40 }
};

/**
 * Compute price for a given vehicle type and distance.
 * Rule:
 *  - if distance <= withinKm → price = minCharge
 *  - else price = minCharge + perKm * (distance - withinKm)
 * Rounded to nearest rand.
 */
export function priceForDistanceKm(distanceKm, vehicleType = 'normal') {
  const key = (vehicleType || 'normal').toLowerCase();
  const rate = RATE_TABLE[key] || RATE_TABLE.normal;

  if (distanceKm <= rate.withinKm) return rate.minCharge;

  const extraKm = distanceKm - rate.withinKm;
  const price = rate.minCharge + rate.perKm * extraKm;
  return Math.round(price);
}

/**
 * Primary estimator used across the codebase.
 * Accepts an object for flexibility with existing calls.
 * If vehicleType is omitted, defaults to 'normal'.
 */
export function estimatePrice({ pickup, destination, vehicleType = 'normal', driverLocation = null }) {
  // We price by trip distance (pickup → destination). Driver location not required for price.
  const tripKm = kmBetween(pickup, destination);
  const price = priceForDistanceKm(tripKm, vehicleType);
  return { price, km: tripKm };
}
