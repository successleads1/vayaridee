// src/services/pricing.js
import Driver from '../models/Driver.js';

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
 * Default pricing tables (used when a driver didn’t set their own rates)
 * - normal:   perKm 7,  min 30, within 30 km
 * - comfort:  perKm 8,  min 30, within 30 km
 * - luxury:   perKm 12, min 45, within 45 km
 * - xl:       perKm 10, min 39, within 40 km
 */
const DEFAULT_RATE_TABLE = {
  normal:  { baseFare: 0, perKm: 7,  minCharge: 30, withinKm: 30 },
  comfort: { baseFare: 0, perKm: 8,  minCharge: 30, withinKm: 30 },
  luxury:  { baseFare: 0, perKm: 12, minCharge: 45, withinKm: 45 },
  xl:      { baseFare: 0, perKm: 10, minCharge: 39, withinKm: 40 }
};

/** Merge driver.pricing (if any) with defaults for the driver’s vehicleType */
function resolveRate(vehicleType, driverPricing = {}) {
  const key = (vehicleType || 'normal').toLowerCase();
  const def = DEFAULT_RATE_TABLE[key] || DEFAULT_RATE_TABLE.normal;
  return {
    baseFare:  (typeof driverPricing.baseFare  === 'number' ? driverPricing.baseFare  : def.baseFare),
    perKm:     (typeof driverPricing.perKm     === 'number' ? driverPricing.perKm     : def.perKm),
    minCharge: (typeof driverPricing.minCharge === 'number' ? driverPricing.minCharge : def.minCharge),
    withinKm:  (typeof driverPricing.withinKm  === 'number' ? driverPricing.withinKm  : def.withinKm)
  };
}

/** Price using a resolved rate object */
export function priceWithRate(distanceKm, rate) {
  const within = rate.withinKm ?? 0;
  const min    = rate.minCharge ?? 0;
  const perKm  = rate.perKm ?? 0;
  const base   = rate.baseFare ?? 0;

  const variable =
    distanceKm <= within
      ? 0
      : perKm * (distanceKm - within);

  return Math.round(base + min + variable);
}

/**
 * Legacy helper (kept for compatibility in other parts):
 * price by vehicle type only (using default table).
 */
export function priceForDistanceKm(distanceKm, vehicleType = 'normal') {
  const key = (vehicleType || 'normal').toLowerCase();
  const rate = DEFAULT_RATE_TABLE[key] || DEFAULT_RATE_TABLE.normal;
  return priceWithRate(distanceKm, rate);
}

/**
 * Primary estimator object form (legacy compatibility)
 */
export function estimatePrice({ pickup, destination, vehicleType = 'normal' }) {
  const tripKm = kmBetween(pickup, destination);
  const price  = priceForDistanceKm(tripKm, vehicleType);
  return { price, km: tripKm };
}

/**
 * NEW: Dynamic quotes based on *available drivers* near the pickup.
 * Returns only vehicle types that actually have eligible drivers.
 *
 * For each vehicleType, we pick the CHEAPEST driver’s price for this trip.
 *
 * @param {Object} opts
 * @param {{lat:number,lng:number}} opts.pickup
 * @param {{lat:number,lng:number}} opts.destination
 * @param {number} [opts.radiusKm=30]   Only consider drivers within this radius of pickup
 * @returns {Promise<Array<{vehicleType:string, price:number, km:number, driverIds:string[], driverCount:number}>>}
 */
export async function getAvailableVehicleQuotes({ pickup, destination, radiusKm = 30 }) {
  const tripKm = kmBetween(pickup, destination);

  // Find eligible drivers: approved, online, with numeric chatId & a last location.
  const drivers = await Driver.find({
    status: 'approved',
    isAvailable: true,
    chatId: { $type: 'number' },
    'location.lat': { $exists: true },
    'location.lng': { $exists: true }
  }).lean();

  // Keep only those within radius of pickup
  const nearby = drivers.filter(d => {
    if (!d.location) return false;
    const dist = kmBetween(d.location, pickup);
    return dist <= radiusKm;
  });

  // Group by vehicleType
  const byType = nearby.reduce((acc, d) => {
    const vt = (d.vehicleType || 'normal').toLowerCase();
    (acc[vt] ||= []).push(d);
    return acc;
  }, {});

  // For each type, compute the CHEAPEST driver’s quote
  const quotes = Object.entries(byType).map(([vehicleType, ds]) => {
    let bestPrice = Number.POSITIVE_INFINITY;
    let bestDrivers = [];
    for (const d of ds) {
      const rate = resolveRate(vehicleType, d.pricing || {});
      const price = priceWithRate(tripKm, rate);
      if (price < bestPrice) {
        bestPrice = price;
        bestDrivers = [String(d._id)];
      } else if (price === bestPrice) {
        bestDrivers.push(String(d._id));
      }
    }
    return {
      vehicleType,
      price: bestPrice,
      km: tripKm,
      driverIds: bestDrivers,
      driverCount: ds.length
    };
  });

  // Sort by displayed price ascending
  quotes.sort((a, b) => a.price - b.price);
  return quotes;
}
