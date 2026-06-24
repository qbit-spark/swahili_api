const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const { bullMQConnection } = require('../config/redis');
const { JOBS } = require('../queues/referralQueue');
const { REFERRAL_CONFIG, computeRewardAmount, getRateForSubtotal } = require('../config/referralConfig');
const Referral = require('../models/Referral');
const ReferralPayout = require('../models/ReferralPayout');
const Order = require('../models/Order');
const { User } = require('../models/User');
const Shop = require('../models/Shop');
const notificationService = require('../services/notificationService');

/**
 * Credits a referrer based on their role at signup time.
 *   - 'seller' -> Shop.wallet.referralBalance (the seller's own shop)
 *   - 'buyer'  -> User.wallet.balance
 * Returns { creditedTo, creditedShop } for the payout ledger entry.
 */
async function creditReferrer(referrer, referrerRole, amount) {
  if (referrerRole === 'seller') {
    const shop = await Shop.findOne({ owner: referrer._id });
    if (!shop) {
      // Seller referrer with no shop (e.g. account downgraded/shop deleted
      // since signup) — fall back to crediting their personal wallet so the
      // reward isn't silently lost.
      referrer.wallet = referrer.wallet || { balance: 0 };
      referrer.wallet.balance = (referrer.wallet.balance || 0) + amount;
      await referrer.save();
      return { creditedTo: 'user_wallet', creditedShop: null };
    }
    shop.wallet = shop.wallet || { currentBalance: 0, lockedBalance: 0, referralBalance: 0, currency: 'TZS' };
    shop.wallet.referralBalance = (shop.wallet.referralBalance || 0) + amount;
    await shop.save();
    return { creditedTo: 'shop_wallet', creditedShop: shop._id };
  }

  // buyer referrer
  referrer.wallet = referrer.wallet || { balance: 0 };
  referrer.wallet.balance = (referrer.wallet.balance || 0) + amount;
  await referrer.save();
  return { creditedTo: 'user_wallet', creditedShop: null };
}

/**
 * Credits the referee's flat one-time welcome bonus to their User wallet.
 * Referees are always credited via their personal User wallet regardless
 * of whether they're a buyer or seller — this is a signup incentive, not
 * a sales-linked reward.
 */
async function creditRefereeWelcomeBonus(referee, amount) {
  referee.wallet = referee.wallet || { balance: 0 };
  referee.wallet.balance = (referee.wallet.balance || 0) + amount;
  await referee.save();
}

const referralWorker = new Worker(
  'referral-ledger',
  async (job) => {
    if (job.name === JOBS.EXPIRE_CHECK) {
      await handleExpireCheck(job.data);
    } else if (job.name === JOBS.PAY_REWARD) {
      await handlePayReward(job.data);
    }
  },
  { connection: bullMQConnection, concurrency: 5 }
);

/**
 * EXPIRE_CHECK: fires once, `activationWindowDays` after signup.
 * If the referral is still 'pending' (referee never placed a qualifying
 * order in time), mark it 'expired' permanently. If it already became
 * 'active', this is a no-op — the link keeps paying out forever.
 */
async function handleExpireCheck({ referralId }) {
  const referral = await Referral.findById(referralId);
  if (!referral) {
    console.warn(`[Referral] expire-check: referral ${referralId} not found (deleted?)`);
    return;
  }
  if (referral.status !== 'pending') {
    // Already active (or somehow already expired) — nothing to do.
    return;
  }
  referral.status = 'expired';
  await referral.save();
  console.log(`[Referral] ${referralId} expired — referee never placed a qualifying order in time`);
}

/**
 * PAY_REWARD: fires every time a referee's order transitions to 'delivered'.
 * Looks up whether this user IS a referee on an active/pending referral,
 * computes the tiered reward off the order subtotal, and credits the
 * referrer. On the referee's FIRST qualifying order, also flips the
 * referral to 'active' and pays the one-time welcome credit.
 */
async function handlePayReward({ orderId, userId }) {
  const referral = await Referral.findOne({ referee: userId });
  if (!referral) return; // this user was never referred — nothing to do
  if (referral.status === 'expired') return; // dead link, no more payouts ever

  const order = await Order.findById(orderId);
  if (!order || order.status !== 'delivered') {
    console.warn(`[Referral] pay-reward: order ${orderId} not found or not delivered, skipping`);
    return;
  }

  const subtotal = Number(order.amounts?.subtotal || order.amounts?.total || 0);

  // Guard against double-processing the same order (e.g. job retried after
  // a crash post-payout). The ReferralPayout ledger is the source of truth.
  const alreadyPaid = await ReferralPayout.exists({ referral: referral._id, order: order._id, payoutType: 'order_reward' });
  if (alreadyPaid) {
    console.log(`[Referral] order ${orderId} already rewarded for referral ${referral._id}, skipping`);
    return;
  }

  const isFirstQualification = referral.status === 'pending';

  // First-ever qualifying order must land within the activation window.
  // (Edge case: job could in theory run after expiresAt if the queue was
  // delayed — re-check here rather than trusting the expire job alone.)
  if (isFirstQualification && new Date() > referral.expiresAt) {
    referral.status = 'expired';
    await referral.save();
    console.log(`[Referral] ${referral._id} order ${orderId} arrived after expiry window, link expired, no reward`);
    return;
  }

  const rate = getRateForSubtotal(subtotal);
  const rewardAmount = computeRewardAmount(subtotal);

  const referrer = await User.findById(referral.referrer);
  if (!referrer) {
    console.error(`[Referral] referrer ${referral.referrer} missing for referral ${referral._id}`);
    return;
  }

  // Pay the referrer (even if rewardAmount is 0 for a sub-threshold order —
  // we still want to activate the link on first qualifying order; "qualifying"
  // here just means "delivered", per product decision, so a sub-5000 first
  // order still activates the link, it just pays 0 for that one order).
  if (rewardAmount > 0) {
    const { creditedTo, creditedShop } = await creditReferrer(referrer, referral.referrerRole, rewardAmount);

    await ReferralPayout.create({
      referral: referral._id,
      recipient: referrer._id,
      recipientType: 'referrer',
      payoutType: 'order_reward',
      order: order._id,
      orderSubtotal: subtotal,
      rateApplied: rate,
      amount: rewardAmount,
      currency: REFERRAL_CONFIG.currency,
      creditedTo,
      creditedShop,
    });

    referral.totalEarned = (referral.totalEarned || 0) + rewardAmount;
    referral.payoutCount = (referral.payoutCount || 0) + 1;

    await notificationService.createPersistentNotification(
      referrer._id,
      `You earned ${rewardAmount} ${REFERRAL_CONFIG.currency} from a referral purchase!`,
      order._id
    ).catch((err) => console.error('[Referral] notification failed:', err.message));
  }

  // Handle first-qualification side effects: activate link + welcome credit
  if (isFirstQualification) {
    referral.status = 'active';
    referral.firstQualifiedAt = new Date();

    if (!referral.welcomeCreditPaid && REFERRAL_CONFIG.refereeWelcomeCredit > 0) {
      const referee = await User.findById(referral.referee);
      if (referee) {
        await creditRefereeWelcomeBonus(referee, REFERRAL_CONFIG.refereeWelcomeCredit);
        referral.welcomeCreditPaid = true;
        referral.welcomeCreditAmount = REFERRAL_CONFIG.refereeWelcomeCredit;

        await ReferralPayout.create({
          referral: referral._id,
          recipient: referee._id,
          recipientType: 'referee',
          payoutType: 'welcome_credit',
          order: order._id,
          amount: REFERRAL_CONFIG.refereeWelcomeCredit,
          currency: REFERRAL_CONFIG.currency,
          creditedTo: 'user_wallet',
        });

        await notificationService.createPersistentNotification(
          referee._id,
          `Welcome bonus: ${REFERRAL_CONFIG.refereeWelcomeCredit} ${REFERRAL_CONFIG.currency} added to your wallet!`,
          order._id
        ).catch((err) => console.error('[Referral] notification failed:', err.message));
      }
    }
  }

  await referral.save();
  console.log(`[Referral] order ${orderId} processed for referral ${referral._id} — reward: ${rewardAmount}, firstQualification: ${isFirstQualification}`);
}

referralWorker.on('failed', (job, err) => {
  console.error(`[Worker:referral-ledger] Job ${job?.id} (${job?.name}) failed:`, err.message);
});

module.exports = { referralWorker };