const mongoose = require('mongoose');

// ─── Tier definitions — single source of truth ────────────────────────────────
// Exported so controllers/workers reference the same numbers everywhere.
const TIERS = {
  NONE:  'none',
  BLUE:  'blue',
  GREEN: 'green',
  GOLD:  'gold',
};

const TIER_ORDER = [TIERS.NONE, TIERS.BLUE, TIERS.GREEN, TIERS.GOLD];

function tierRequirement(minProducts, minOrders, minRating, requiredDocs, listingCap) {
  return { minProducts, minOrders, minRating, requiredDocs, listingCap };
}

const TIER_REQUIREMENTS = {
  [TIERS.BLUE]:  tierRequirement(50,  0,   0,   [],                    200),
  [TIERS.GREEN]: tierRequirement(200, 100, 0,   ['national_id'],       500),
  [TIERS.GOLD]:  tierRequirement(500, 500, 4.5, ['business_license'],  Infinity),
};

// Listing cap for sellers with no badge at all
const UNVERIFIED_LISTING_CAP = 50;

// Explore score multiplier per tier — small, deliberate boosts, not overwhelming
const EXPLORE_BOOST = {
  [TIERS.NONE]:  1.0,
  [TIERS.BLUE]:  1.05,
  [TIERS.GREEN]: 1.12,
  [TIERS.GOLD]:  1.20,
};

// Grace period before a badge is revoked after dropping below threshold (days)
const REVOCATION_GRACE_DAYS = 30;

// Rating floor below which Gold is revoked regardless of other metrics
const GOLD_RATING_FLOOR = 4.0;

// ─── Document sub-schema ──────────────────────────────────────────────────────
const documentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['national_id', 'business_license', 'other'],
      required: true,
    },
    url:       { type: String, required: true },
    publicId:  { type: String, required: true },
    uploadedAt:{ type: Date, default: Date.now },
  },
  { _id: true }
);

// ─── Application sub-schema ───────────────────────────────────────────────────
// One per tier application attempt — preserves full history even across
// rejections and re-applications, so admins can see prior context.
const applicationSchema = new mongoose.Schema(
  {
    tier: {
      type: String,
      enum: [TIERS.BLUE, TIERS.GREEN, TIERS.GOLD],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    documents: [documentSchema],

    // Snapshot of metrics at time of application — lets admin see
    // "did they actually qualify when they applied" even if metrics
    // change later (e.g. seller deletes products right after applying)
    metricsSnapshot: {
      totalProducts: { type: Number, default: 0 },
      totalOrders:   { type: Number, default: 0 },
      avgRating:     { type: Number, default: 0 },
    },

    reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt:  { type: Date, default: null },
    reviewNotes: { type: String, default: '' },
  },
  { timestamps: true }
);

// ─── Revocation log sub-schema ────────────────────────────────────────────────
const revocationSchema = new mongoose.Schema(
  {
    fromTier: { type: String, required: true },
    toTier:   { type: String, required: true },
    reason:   { type: String, required: true }, // e.g. "products dropped below 200 for 30+ days"
    revokedAt:{ type: Date, default: Date.now },
    automatic:{ type: Boolean, default: true }, // false if an admin manually revoked
  },
  { _id: false }
);

// ─── Main schema ──────────────────────────────────────────────────────────────
const sellerVerificationSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
    },

    currentTier: {
      type: String,
      enum: Object.values(TIERS),
      default: TIERS.NONE,
      index: true,
    },

    // When the current tier was granted — used for grace period calculations
    tierGrantedAt: { type: Date, default: null },

    // First date metrics were observed below the current tier's threshold.
    // Cleared back to null if metrics recover before the grace period ends.
    belowThresholdSince: { type: Date, default: null },

    applications: [applicationSchema],
    revocations:  [revocationSchema],

    // Cached metrics — refreshed by the verification worker, avoids
    // recomputing aggregates from Product/Order collections on every check
    metrics: {
      totalProducts: { type: Number, default: 0 },
      totalOrders:   { type: Number, default: 0 },
      avgRating:     { type: Number, default: 0 },
      lastComputedAt:{ type: Date, default: null },
    },
  },
  { timestamps: true }
);

sellerVerificationSchema.index({ currentTier: 1, belowThresholdSince: 1 });

// ─── Instance methods ─────────────────────────────────────────────────────────

/** Returns the pending application for a tier, if one exists */
sellerVerificationSchema.methods.getPendingApplication = function (tier) {
  return this.applications.find((a) => a.tier === tier && a.status === 'pending');
};

/** Returns the listing cap for the seller's current tier */
sellerVerificationSchema.methods.getListingCap = function () {
  if (this.currentTier === TIERS.NONE) return UNVERIFIED_LISTING_CAP;
  return TIER_REQUIREMENTS[this.currentTier]?.listingCap ?? UNVERIFIED_LISTING_CAP;
};

/** Returns the explore score multiplier for the seller's current tier */
sellerVerificationSchema.methods.getExploreBoost = function () {
  return EXPLORE_BOOST[this.currentTier] ?? 1.0;
};

/**
 * Checks if current metrics satisfy a given tier's requirements.
 * Products/orders are OR'd (either satisfies the volume requirement),
 * rating and docs are AND'd (both must be satisfied independently).
 */
sellerVerificationSchema.methods.meetsRequirements = function (tier) {
  const req = TIER_REQUIREMENTS[tier];
  if (!req) return false;

  const volumeOk = this.metrics.totalProducts >= req.minProducts ||
                    this.metrics.totalOrders   >= req.minOrders;
  const ratingOk  = this.metrics.avgRating >= req.minRating;

  return volumeOk && ratingOk;
};

module.exports = {
  SellerVerification: mongoose.model('SellerVerification', sellerVerificationSchema),
  TIERS,
  TIER_ORDER,
  TIER_REQUIREMENTS,
  UNVERIFIED_LISTING_CAP,
  EXPLORE_BOOST,
  REVOCATION_GRACE_DAYS,
  GOLD_RATING_FLOOR,
};