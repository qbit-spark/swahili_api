const { Queue } = require('bullmq');
const { bullMQConnection } = require('../config/redis');

// ─── Queue: Referral Ledger ───────────────────────────────────────────────────
// Handles two job types:
//   1. expire-check — delayed job scheduled at signup, fires at the end of the
//      30-day activation window to expire any referral that never qualified.
//   2. pay-reward   — fired immediately whenever a referee's order hits
//      'delivered', to compute + credit the referrer (and, on first
//      qualification, the referee's welcome credit) without blocking the
//      order-status HTTP request.
const referralQueue = new Queue('referral-ledger', {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 200 }, // keep history for debugging payouts
    removeOnFail: { count: 100 },
  },
});

const JOBS = {
  EXPIRE_CHECK: 'referral:expire-check',
  PAY_REWARD: 'referral:pay-reward',
};

/**
 * Schedule the activation-window expiry check for a newly created referral.
 * Delayed by `activationWindowDays`. The worker re-checks status at fire
 * time — if the referral already became 'active' in the meantime, this
 * job is a no-op.
 *
 * jobId is the referral's own _id so re-running signup logic (e.g. a retry)
 * never double-schedules the same expiry check.
 */
const scheduleExpireCheck = (referralId, delayMs) =>
  referralQueue.add(
    JOBS.EXPIRE_CHECK,
    { referralId: referralId.toString() },
    {
      jobId: `expire:${referralId.toString()}`,
      delay: delayMs,
    }
  );

/**
 * Trigger a reward payout check for a referee's delivered order.
 * Called from orderController.updateOrderStatus right after an order
 * transitions to 'delivered' — fire-and-forget, doesn't block the response.
 */
const requestRewardPayout = (orderId, userId) =>
  referralQueue.add(
    JOBS.PAY_REWARD,
    { orderId: orderId.toString(), userId: userId.toString() },
    {
      // Dedup safety: if somehow the same order fires twice before the
      // first job completes, don't double-queue it.
      jobId: `reward:${orderId.toString()}`,
    }
  );

module.exports = {
  referralQueue,
  JOBS,
  scheduleExpireCheck,
  requestRewardPayout,
};