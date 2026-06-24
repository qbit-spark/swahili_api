const mongoose = require('mongoose');

/**
 * ReferralPayout — append-only ledger entry for a single reward payment.
 *
 * One document per rewarded order (referrer reward) or per welcome credit
 * (referee reward). Never updated or deleted — this is the audit trail
 * that answers "why did my balance change by X" and lets you change rates
 * later without losing history of what was actually paid under old rates.
 */
const referralPayoutSchema = new mongoose.Schema(
  {
    referral: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Referral',
      required: true,
      index: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    recipientType: {
      type: String,
      enum: ['referrer', 'referee'],
      required: true,
    },
    payoutType: {
      type: String,
      enum: ['order_reward', 'welcome_credit'],
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      // not required — welcome_credit payouts are tied to the qualifying
      // order indirectly but we still record it when available
    },
    orderSubtotal: Number, // snapshot, for order_reward payouts
    rateApplied: Number,   // snapshot, e.g. 0.10 — so later rate changes don't rewrite history
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'TZS',
    },
    // Where the credit actually landed — for sellers this is their Shop wallet,
    // for buyers (and referees regardless of role) it's their User wallet.
    creditedTo: {
      type: String,
      enum: ['user_wallet', 'shop_wallet'],
      required: true,
    },
    creditedShop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReferralPayout', referralPayoutSchema);