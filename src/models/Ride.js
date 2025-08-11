import mongoose from 'mongoose';

const PointSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  ts: { type: Date, default: Date.now }
}, { _id: false });

const RideSchema = new mongoose.Schema({
  riderChatId: Number,
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  driverChatId: { type: Number }, // quick access for bot + sockets
  pickup: { lat: Number, lng: Number },
  destination: { lat: Number, lng: Number },
  estimate: Number,
  paymentMethod: { type: String, enum: ['cash', 'payfast'], default: 'cash' },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'enroute', 'completed', 'cancelled', 'payment_pending'],
    default: 'pending'
  },
  cancelReason: { type: String },
  path: [PointSchema],        // driver breadcrumb
  viewerPath: [PointSchema]   // optional viewer breadcrumb
}, { timestamps: true });

const Ride = mongoose.model('Ride', RideSchema);
export default Ride;
