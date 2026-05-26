const mongoose = require('mongoose');

const productViewSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  ip: { type: String },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  timestamp: { type: Date, default: Date.now, expires: 86400 } // TTL: auto-delete after 24h
});

// Compound index to make the "has this IP/user viewed recently?" check fast
productViewSchema.index({ product: 1, ip: 1 });
productViewSchema.index({ product: 1, user: 1 });

module.exports = mongoose.model('ProductView', productViewSchema);