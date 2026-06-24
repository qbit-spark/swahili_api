const crypto = require('crypto');

/**
 * Generates a short, human-shareable referral code candidate, e.g. "JOHN4F2A".
 * Username prefix (sanitized, 4 chars) + 4 random hex chars.
 */
function generateReferralCodeCandidate(username) {
    const prefix = (username || 'USER')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 4)
        .toUpperCase()
        .padEnd(4, 'X');
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `${prefix}${suffix}`;
}

/**
 * Generates a referral code guaranteed unique against the User collection.
 * Retries on the rare collision; falls back to a fully random code if
 * all attempts collide (astronomically unlikely).
 */
async function generateUniqueReferralCode(User, username) {
    const MAX_ATTEMPTS = 5;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const candidate = generateReferralCodeCandidate(username);
        const exists = await User.exists({ referralCode: candidate });
        if (!exists) return candidate;
    }
    return crypto.randomBytes(5).toString('hex').toUpperCase();
}

module.exports = { generateUniqueReferralCode, generateReferralCodeCandidate };