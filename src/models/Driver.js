// src/models/Driver.js
import mongoose from 'mongoose';
import Ride from './Ride.js'; // used by computeAndUpdateStats

/* ---------------- helpers ---------------- */
function toRad(x){ return (x * Math.PI) / 180; }
function haversineMeters(a, b){
  if (!a || !b || typeof a.lat !== 'number' || typeof a.lng !== 'number' ||
      typeof b.lat !== 'number' || typeof b.lng !== 'number') return 0;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat/2) ** 2 +
    Math.cos(toRad(a.lat)) *
    Math.cos(toRad(b.lat)) *
    Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.max(0, s)));
}
function pathDistanceM(path = []){
  let m = 0;
  for (let i = 1; i < path.length; i++) m += haversineMeters(path[i-1], path[i]);
  return Math.round(m);
}
function pathDurationSec(path = [], createdAt, updatedAt){
  const firstTs = path[0]?.ts ? new Date(path[0].ts).getTime() : (createdAt ? new Date(createdAt).getTime() : null);
  const lastTs  = path[path.length-1]?.ts ? new Date(path[path.length-1].ts).getTime() : (updatedAt ? new Date(updatedAt).getTime() : null);
  if (!firstTs || !lastTs || lastTs < firstTs) return 0;
  return Math.round((lastTs - firstTs) / 1000);
}

/* ---------------- stats subdocs ---------------- */
const DriverStatsLastTripSchema = new mongoose.Schema({
  rideId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Ride' },
  startedAt:      Date,
  pickedAt:       Date,
  finishedAt:     Date,
  durationSec:    { type: Number, default: 0 },
  distanceMeters: { type: Number, default: 0 },
  amount:         { type: Number, default: 0 },
  currency:       { type: String, default: 'ZAR' },
  method:         { type: String, enum: ['cash', 'payfast', 'app', null], default: null },
  pickup:         { lat: Number, lng: Number },
  drop:           { lat: Number, lng: Number }
}, { _id: false });

const DriverStatsSchema = new mongoose.Schema({
  totalTrips:      { type: Number, default: 0 },   // completed
  totalDistanceM:  { type: Number, default: 0 },
  totalEarnings:   { type: Number, default: 0 },   // sum amounts of completed rides
  cashCount:       { type: Number, default: 0 },
  payfastCount:    { type: Number, default: 0 },   // counts 'payfast' or 'app'
  currency:        { type: String, default: 'ZAR' },
  lastTrip:        { type: DriverStatsLastTripSchema, default: () => ({}) }
}, { _id: false });

/* ---------------- main driver schema ---------------- */
const DriverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, index: true, unique: true, sparse: true },
  passwordHash: { type: String },

  vehicleType: { type: String, enum: ['normal', 'comfort', 'luxury', 'xl'], default: 'normal' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },

  chatId: Number,
  location: { lat: Number, lng: Number },
  isAvailable: { type: Boolean, default: false },
  lastSeenAt: { type: Date },

  pricing: {
    baseFare:   { type: Number, default: 0 },
    perKm:      { type: Number },
    minCharge:  { type: Number },
    withinKm:   { type: Number }
  },

  botPin: { type: String },
  approvedAt: { type: Date },

  documents: {
    driverProfilePhoto: String,
    vehiclePhoto: String,
    idDocument: String,
    vehicleRegistration: String,
    driversLicense: String,
    insuranceCertificate: String,
    pdpOrPsv: String,
    dekraCertificate: String,
    policeClearance: String,
    licenseDisc: String
  },

  stats: { type: DriverStatsSchema, default: () => ({}) }
}, { timestamps: true });

/* ---------------- static: recompute stats from rides ---------------- */
DriverSchema.statics.computeAndUpdateStats = async function (driverId) {
  const drvId = typeof driverId === 'string' ? new mongoose.Types.ObjectId(driverId) : driverId;

  // Completed rides for this driver
  const rides = await Ride.find({
    driverId: drvId,
    status: 'completed'
  }).sort({ updatedAt: -1 }).lean();

  let totalTrips = 0;
  let totalEarnings = 0;
  let totalDistanceM = 0;
  let cashCount = 0;
  let payfastCount = 0;

  for (const r of rides) {
    totalTrips += 1;

    // Prefer final amounts/distances; fall back gracefully
    const amt = (r.finalAmount != null ? Number(r.finalAmount) : Number(r.estimate || 0));
    const distM = Number.isFinite(r.finalDistanceKm) ? Number(r.finalDistanceKm) * 1000 : pathDistanceM(r.path || []);

    totalEarnings += Number.isFinite(amt) ? amt : 0;
    totalDistanceM += Number.isFinite(distM) ? distM : 0;

    // Treat 'app' same as 'payfast' in counts
    if (r.paymentMethod === 'cash') cashCount += 1;
    if (r.paymentMethod === 'payfast' || r.paymentMethod === 'app') payfastCount += 1;
  }

  const last = rides[0];
  const lastTrip = last ? {
    rideId: last._id,
    startedAt: last.createdAt || null,
    pickedAt:  last.pickedAt || null,
    finishedAt: last.completedAt || last.updatedAt || null,
    durationSec: pathDurationSec(last.path || [], last.createdAt, last.updatedAt),
    distanceMeters: Number.isFinite(last.finalDistanceKm) ? Math.round(Number(last.finalDistanceKm) * 1000) : pathDistanceM(last.path || []),
    amount: (last.finalAmount != null ? Number(last.finalAmount) : Number(last.estimate || 0)),
    currency: 'ZAR',
    method: (last.paymentMethod === 'cash' || last.paymentMethod === 'payfast' || last.paymentMethod === 'app') ? last.paymentMethod : null,
    pickup: last.pickup || null,
    drop: last.destination || null
  } : {};

  const update = {
    'stats.totalTrips': totalTrips,
    'stats.totalEarnings': Math.round(totalEarnings),
    'stats.totalDistanceM': Math.round(totalDistanceM),
    'stats.cashCount': cashCount,
    'stats.payfastCount': payfastCount,
    'stats.currency': 'ZAR',
    'stats.lastTrip': lastTrip
  };

  await mongoose.model('Driver').findByIdAndUpdate(drvId, { $set: update }, { new: true });
  return update;
};

export default mongoose.model('Driver', DriverSchema);
