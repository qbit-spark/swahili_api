const mongoose = require('mongoose');

// Lightweight interest vector per user.
// Each category gets a weight that grows with purchases and views,
// decayed over time so stale interests fade naturally.
const userInterestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    // Category affinity map: { categoryId: score }
    // Score range: 0.0 – 1.0 (normalized after each update)
    // Purchase contributes 1.0, view contributes 0.2
    categoryAffinities: {
      type: Map,
      of: Number,
      default: {},
    },

    // Raw signal counts for transparency / debugging
    signalCounts: {
      purchases: { type: Number, default: 0 },
      views: { type: Number, default: 0 },
    },

    // Last time interests were recomputed from scratch
    // Used to trigger periodic full recalculation
    lastFullRecalcAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Increment a category's affinity score, then re-normalize all scores
// so the highest value is always 1.0 (keeps scores comparable across users)
userInterestSchema.methods.addSignal = function (categoryId, weight) {
  const id = categoryId.toString();
  const current = this.categoryAffinities.get(id) || 0;
  this.categoryAffinities.set(id, current + weight);
  this._normalize();
};

userInterestSchema.methods._normalize = function () {
  const entries = [...this.categoryAffinities.entries()];
  if (!entries.length) return;

  const max = Math.max(...entries.map(([, v]) => v));
  if (max === 0) return;

  for (const [k, v] of entries) {
    this.categoryAffinities.set(k, parseFloat((v / max).toFixed(4)));
  }
};

// Get affinity for a specific category (0 if unknown)
userInterestSchema.methods.affinityFor = function (categoryId) {
  return this.categoryAffinities.get(categoryId.toString()) || 0;
};

// Return top N categories by affinity score
userInterestSchema.methods.topCategories = function (n = 5) {
  return [...this.categoryAffinities.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([categoryId, score]) => ({ categoryId, score }));
};

module.exports = mongoose.model('UserInterest', userInterestSchema);