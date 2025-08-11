import mongoose from 'mongoose';

const DriverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, index: true, unique: true, sparse: true },
  passwordHash: { type: String },

  vehicleType: { type: String, enum: ['normal', 'comfort', 'luxury', 'xl'], default: 'normal' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },

  chatId: Number,
  location: { lat: Number, lng: Number },
  isAvailable: { type: Boolean, default: false },

  // NEW: Telegram login PIN + approval timestamp
  botPin: { type: String },        // e.g. "482913"
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
  }
}, { timestamps: true });

export default mongoose.model('Driver', DriverSchema);
