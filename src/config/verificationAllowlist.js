/**
 * config/verificationAllowlist.js
 * ─────────────────────────────────
 * Special-case sellers who get instant approval on application, bypassing
 * the normal metrics/document review. Used for developer accounts, internal
 * test shops, or platform partnerships where manual review doesn't apply.
 *
 * This is intentionally a plain JS array, not a DB collection — it should
 * require a code change + deploy to modify, so it can never be silently
 * edited through the admin panel or an API call. That friction is the point;
 * it keeps the allowlist auditable via git history.
 *
 * Each entry can cap which tier they're allowed to auto-approve for, so a
 * partner account can be fast-tracked to Blue without accidentally getting
 * Gold if someone reuses this list carelessly later.
 */
const VERIFICATION_ALLOWLIST = [
  {
    userId: '679b6396993db2bb852d993a', // e.g. 'sample userId from DB'
    maxTier: 'gold',
    reason: 'Developer account — internal testing',
  },
  // more entries as needed:
  // { userId: '...', maxTier: 'blue', reason: 'Launch partner shop' },
];

/**
 * Returns true if this user is allowlisted for instant approval
 * at the requested tier (or below their maxTier).
 */
const isAllowlistedForTier = (userId, tier) => {
  const entry = VERIFICATION_ALLOWLIST.find((e) => e.userId === userId.toString());
  if (!entry) return false;

  const { TIER_ORDER } = require('../models/SellerVerification');
  const requestedIdx = TIER_ORDER.indexOf(tier);
  const maxIdx       = TIER_ORDER.indexOf(entry.maxTier);

  return requestedIdx >= 0 && requestedIdx <= maxIdx;
};

module.exports = { VERIFICATION_ALLOWLIST, isAllowlistedForTier };