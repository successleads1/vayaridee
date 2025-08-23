// src/models/Admin.js
import mongoose from 'mongoose';

const AdminSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, index: true, required: true },
  passwordHash: { type: String, required: true }
}, { timestamps: true });

export default mongoose.model('Admin', AdminSchema);
