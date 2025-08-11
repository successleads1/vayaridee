import mongoose from 'mongoose';

const RideSchema = new mongoose.Schema({
  riderChatId: Number,
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  pickup: {
    lat: Number,
    lng: Number
  },
  destination: {
    lat: Number,
    lng: Number
  },
  estimate: Number,
  paymentMethod: {
    type: String,
    enum: ['cash', 'payfast'],
    default: 'cash'
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'enroute', 'completed', 'cancelled', 'payment_pending'],
    default: 'pending'
  },
  cancelReason: {
    type: String
  }
}, { timestamps: true });

const Ride = mongoose.model('Ride', RideSchema);

export default Ride;
