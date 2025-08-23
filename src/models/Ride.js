// src/models/Ride.js
import mongoose from 'mongoose';

const PointSchema = new mongoose.Schema(
  {
    lat: Number,
    lng: Number,
    ts: { type: Date, default: Date.now }
  },
  { _id: false }
);

const RideSchema = new mongoose.Schema(
  {
    // Rider identities
    riderChatId: Number,          // Telegram (legacy)
    riderWaJid: { type: String }, // WhatsApp JID

    // Driver
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
    driverChatId: { type: Number }, // quick access for bot/sockets

    // Route
    pickup: { lat: Number, lng: Number },
    destination: { lat: Number, lng: Number },

    // Quoting / vehicle
    estimate: Number,
    vehicleType: { type: String },

    // Payment
    paymentMethod: { type: String, enum: ['cash', 'payfast'], default: 'cash' },

    // ⭐ ADDED: PayFast/Payment tracking
    paymentStatus: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
    paidAt: { type: Date },

    // Lifecycle
    status: {
      type: String,
      enum: ['pending', 'accepted', 'enroute', 'completed', 'cancelled', 'payment_pending'],
      default: 'pending'
    },

    // Cancel details (keep both names for compatibility)
    cancelReason: { type: String },            // legacy name
    cancellationReason: { type: String },      // new, matches server code
    cancellationNote: { type: String },
    cancelledAt: { type: Date },
    cancelledBy: { type: String, enum: ['driver', 'rider', 'system'], default: undefined },

    // Time markers (optional but useful)
    startedAt: { type: Date },
    pickedAt: { type: Date },
    completedAt: { type: Date },

    // Final fare snapshot (set on finish)
    finalAmount: { type: Number },         // R amount actually charged
    finalDistanceKm: { type: Number },     // computed trip km
    finalDurationSec: { type: Number },    // actual duration sec
    finalTrafficFactor: { type: Number },  // ratio actual/expected
    finalSurge: { type: Number },          // surge used at finish

    // Breadcrumbs
    path: [PointSchema],        // driver breadcrumb (we append final/cancel stamp here)
    viewerPath: [PointSchema],  // optional breadcrumb from viewers

    // Source platform (for notifications)
    platform: { type: String, enum: ['telegram', 'whatsapp', null], default: null }
  },
  { timestamps: true }
);

const Ride = mongoose.model('Ride', RideSchema);
export default Ride;
