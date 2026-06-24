/**
 * Referral program configuration.
 *
 * To change rates (e.g. for a seasonal promo), edit `tiers` and redeploy.
 * Tiers are checked in array order — the FIRST matching tier wins, so keep
 * them sorted highest `minSubtotal` first.
 *
 * Example seasonal bump (temporary): duplicate this file's tiers with higher
 * rates, swap it in before the promo, swap back after — or add validFrom/
 * validUntil fields here later if you want date-bound tiers without a redeploy.
 */

const TIERS = [
    { minSubtotal: 10000, rate: 0.05 }, // orders >= 10,000 TZS earn referrer 5%
    { minSubtotal: 5000, rate: 0.10 },  // orders >= 5,000 TZS earn referrer 10%
    // orders below 5,000 TZS earn nothing — implicit, no tier matches
];

const REFERRAL_CONFIG = {
    tiers: TIERS,

    // One-time flat credit given to the REFEREE (new signup) the first time
    // they complete a qualifying (delivered) order. Not subject to tiers.
    refereeWelcomeCredit: 2000,

    // Referee must place their FIRST delivered order within this many days of
    // signup, or the referral link expires and never activates.
    // Once activated, there is no further time limit — referrer earns on
    // every future delivered order from this referee, indefinitely.
    activationWindowDays: 30,

    // Minimum order subtotal (TZS) to count as a "qualifying" order at all.
    // Mirrors the lowest tier's minSubtotal — kept separate in case you want
    // a qualifying floor below the lowest paying tier in the future.
    minQualifyingSubtotal: 5000,

    currency: 'TZS',
};

/**
 * Returns the reward rate (0-1) for a given order subtotal, or 0 if no
 * tier matches (i.e. the order doesn't qualify for any reward).
 */
function getRateForSubtotal(subtotal) {
    for (const tier of REFERRAL_CONFIG.tiers) {
        if (subtotal >= tier.minSubtotal) return tier.rate;
    }
    return 0;
}

/**
 * Computes the referrer's reward amount (TZS) for a given order subtotal.
 * Rounded down to the nearest whole unit (no fractional TZS).
 */
function computeRewardAmount(subtotal) {
    const rate = getRateForSubtotal(subtotal);
    if (rate <= 0) return 0;
    return Math.floor(subtotal * rate);
}

module.exports = {
    REFERRAL_CONFIG,
    getRateForSubtotal,
    computeRewardAmount,
};