// src/models/Rider.js
import mongoose from 'mongoose';

const RiderSchema = new mongoose.Schema({
  chatId: Number,
  name: String,
  email: String,
  credit: Number,
  dashboardToken: String,
  dashboardPin: String,
  dashboardTokenExpiry: Date,
  trips: { type: Number, default: 0 }
});

const Rider = mongoose.model('Rider', RiderSchema);

export default Rider;
