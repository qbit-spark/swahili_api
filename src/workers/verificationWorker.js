const { Worker } = require('bullmq');
const { bullMQConnection } = require('../config/redis');
const { JOBS } = require('../queues/verificationQueue');
const {
  SellerVerification, TIERS, TIER_ORDER, TIER_REQUIREMENTS,
  REVOCATION_GRACE_DAYS, GOLD_RATING_FLOOR,
} = require('../models/SellerVerification');
const { computeMetrics } = require('../controllers/verificationController');


/**
 * One tier step down from the given tier. Floors at NONE.
 */
const stepDown = (tier) => {
  const idx = TIER_ORDER.indexOf(tier);
  return idx > 0 ? TIER_ORDER[idx - 1] : TIERS.NONE;
};

const loadVerificationBoosts = async (sellerIds) => {
  const records = await SellerVerification.find({
    seller: { $in: sellerIds },
  }).select('seller currentTier').lean();

  const boostMap = {};
  const EXPLORE_BOOST = { none: 1.0, blue: 1.05, green: 1.12, gold: 1.20 };
  records.forEach((r) => {
    boostMap[r.seller.toString()] = EXPLORE_BOOST[r.currentTier] ?? 1.0;
  });
  return boostMap;
};

/**
 * Checks whether a seller's CURRENT tier requirements are still met.
 * Gold has an extra hard floor on rating that triggers immediate
 * grace-period tracking even if volume requirements are still satisfied —
 * a seller who tanks their rating shouldn't keep Gold just because they
 * still have 500+ products.
 */
const stillMeetsCurrentTier = (record) => {
  if (record.currentTier === TIERS.NONE) return true; // nothing to lose

  const req = TIER_REQUIREMENTS[record.currentTier];
  const volumeOk = record.metrics.totalProducts >= req.minProducts ||
    record.metrics.totalOrders >= req.minOrders;
  const ratingOk = record.metrics.avgRating >= req.minRating;

  // Extra hard floor for Gold specifically
  if (record.currentTier === TIERS.GOLD && record.metrics.avgRating < GOLD_RATING_FLOOR) {
    return false;
  }

  return volumeOk && ratingOk;
};

const verificationWorker = new Worker(
  'verification-checks',
  async (job) => {
    if (job.name !== JOBS.CHECK_ALL_TIERS) return;

    console.log('[Verification] Starting nightly revocation sweep...');

    const verifiedSellers = await SellerVerification.find({
      currentTier: { $ne: TIERS.NONE },
    });

    let revokedCount = 0;
    let recoveredCount = 0;
    const now = new Date();

    for (const record of verifiedSellers) {
      // Refresh metrics for this seller
      const freshMetrics = await computeMetrics(record.seller, record.shop);
      record.metrics = freshMetrics;

      const meetsTier = stillMeetsCurrentTier(record);

      if (meetsTier) {
        // Seller recovered — clear any grace period tracking
        if (record.belowThresholdSince) {
          record.belowThresholdSince = null;
          recoveredCount++;
        }
        await record.save();
        continue;
      }

      // Seller is below threshold for their current tier
      if (!record.belowThresholdSince) {
        // First time observed below threshold — start the grace period clock
        record.belowThresholdSince = now;
        await record.save();
        console.log(`[Verification] ${record.seller} started grace period for ${record.currentTier}`);
        continue;
      }

      // Already in grace period — check if it has expired
      const daysBelow = (now - new Date(record.belowThresholdSince)) / (1000 * 60 * 60 * 24);

      if (daysBelow >= REVOCATION_GRACE_DAYS) {
        const fromTier = record.currentTier;
        const toTier = stepDown(fromTier);

        record.revocations.push({
          fromTier,
          toTier,
          reason: `Metrics fell below ${fromTier} requirements for ${REVOCATION_GRACE_DAYS}+ days `
            + `(products: ${freshMetrics.totalProducts}, orders: ${freshMetrics.totalOrders}, `
            + `rating: ${freshMetrics.avgRating})`,
          automatic: true,
        });

        record.currentTier = toTier;
        record.belowThresholdSince = null; // reset — now measured against the lower tier
        revokedCount++;

        console.log(`[Verification] Revoked ${record.seller}: ${fromTier} → ${toTier}`);

        // TODO: trigger a notification to the seller here via your existing
        // notification system (push/email) — out of scope for this worker
      }

      await record.save();
    }

    console.log(
      `[Verification] Sweep complete — ${revokedCount} revoked, ${recoveredCount} recovered, ` +
      `${verifiedSellers.length} checked`
    );
  },
  {
    connection: bullMQConnection,
    concurrency: 1, // bulk sweep — sequential is safer for this kind of job
  }
);

verificationWorker.on('failed', (job, err) => {
  console.error(`[Verification Worker] Job ${job?.id} failed:`, err.message);
});

module.exports = { verificationWorker };