const mongoose = require('mongoose');

// A single scored content reference inside a trending snapshot
const trendingItemSchema = new mongoose.Schema(
  {
    contentId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    contentType: {
      type: String,
      enum: ['product', 'post', 'video', 'ama'],
      required: true,
    },
    score: { type: Number, required: true },
    breakdown: {
      trendVelocity:    Number,
      engagementRate:   Number,
      freshness:        Number,
      categoryAffinity: Number,
    },
  },
  { _id: false }
);

// One document per content type — upserted by the trend-scorer worker
// This acts as a materialized view so the API never has to recompute
const trendingSchema = new mongoose.Schema(
  {
    // One doc per type, keyed on this field
    contentType: {
      type: String,
      enum: ['product', 'post', 'video', 'ama'],
      required: true,
      unique: true,
    },

    // Top N scored items (default: top 200, enough for many pages)
    items: [trendingItemSchema],

    // Cursor index map: _id → position in items array
    // Lets us resume pagination without full array scan
    itemCount: { type: Number, default: 0 },

    // When this snapshot was last computed
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

trendingSchema.index({ contentType: 1 });

module.exports = mongoose.model('Trending', trendingSchema);