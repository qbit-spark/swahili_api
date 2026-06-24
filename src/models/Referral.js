const mongoose = require('mongoose');
const { REFERRAL_CONFIG } = require('../config/referralConfig');

/**
 * Referral — the link created when a user signs up using someone else's
 * referral code. One document per (referrer, referee) pair.
 *
 * Lifecycle:
 *   pending  -> referee has signed up, hasn't completed a qualifying
 *               (delivered, >= minQualifyingSubtotal) order yet.
 *   active   -> referee placed their first qualifying order within the
 *               activation window. Referrer now earns on EVERY future
 *               delivered order the referee places, forever. No further
 *               expiry once active.
 *   expired  -> referee did not place a qualifying order within
 *               `expiresAt`. Link is dead — no rewards will ever be paid
 *               on it, even if the referee orders later.
 */
const referralSchema = new mongoose.Schema(
    {
        referrer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        referee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true, // a user can only ever be REFERRED once
            index: true,
        },
        // Snapshot of what the referrer was at signup time (buyer or seller).
        // Determines where rewards land (User.wallet vs Shop.wallet.referralBalance).
        referrerRole: {
            type: String,
            enum: ['buyer', 'seller'],
            required: true,
        },
        referralCodeUsed: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: ['pending', 'active', 'expired'],
            default: 'pending',
            index: true,
        },
        expiresAt: {
            type: Date,
            required: true,
        },
        firstQualifiedAt: Date, // set once, when status flips pending -> active
        welcomeCreditPaid: {
            type: Boolean,
            default: false,
        },
        welcomeCreditAmount: {
            type: Number,
            default: 0,
        },
        // Running total paid out to the referrer across all orders. Denormalized
        // for fast dashboard display — source of truth is the ReferralPayout ledger.
        totalEarned: {
            type: Number,
            default: 0,
        },
        payoutCount: {
            type: Number,
            default: 0,
        },
    },
    { timestamps: true }
);

referralSchema.statics.createForSignup = function ({ referrer, referee, referrerRole, referralCodeUsed }) {
    const expiresAt = new Date(Date.now() + REFERRAL_CONFIG.activationWindowDays * 24 * 60 * 60 * 1000);
    return this.create({ referrer, referee, referrerRole, referralCodeUsed, expiresAt });
};

module.exports = mongoose.model('Referral', referralSchema);