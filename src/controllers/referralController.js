const { User } = require('../models/User');
const Referral = require('../models/Referral');
const ReferralPayout = require('../models/ReferralPayout');
const { generateUniqueReferralCode } = require('../utils/referralCode');
const { REFERRAL_CONFIG } = require('../config/referralConfig');

/**
 * GET /api/v1/referrals/resolve/:code
 * PUBLIC (no auth) — used by the mobile app right after extracting a code
 * from a deep link, to check whether the code's owner role matches the
 * app that's currently open. Needed because both the buyer and seller app
 * claim the same https://swahilifamily.com/r/* link on Android, so a
 * seller's code can end up opening inside the buyer app if that's the
 * only one installed.
 *
 * Returns the role so the app can decide: apply silently (role matches)
 * or show "get the right app" (role mismatch).
 */
exports.resolveCode = async (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase();
    const referrer = await User.findOne({ referralCode: code }).select('userType');

    if (!referrer) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Invalid referral code'],
      });
    }

    const role = referrer.userType === 'SELLER' ? 'seller' : 'buyer';

    res.json({
      success: true,
      data: { code, role },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * GET /api/v1/referrals/my-code
 * Returns the current user's referral code, generating one on the fly
 * if they signed up before this feature existed (backfill path).
 */
exports.getMyCode = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, data: null, errors: ['User not found'] });
    }

    if (!user.referralCode) {
      user.referralCode = await generateUniqueReferralCode(User, user.username);
      await user.save();
    }

    const shareUrl = `${process.env.APP_BASE_URL || ''}/signup?ref=${user.referralCode}`;

    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        shareUrl,
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * GET /api/v1/referrals/my-referrals
 * Lists everyone the current user has referred, with status + earnings
 * per referral. Paginated to match your existing pagination middleware
 * pattern (page/limit query params).
 */
exports.getMyReferrals = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const query = { referrer: req.user._id };

    const [referrals, total] = await Promise.all([
      Referral.find(query)
        .populate('referee', 'username profile.firstName profile.lastName profile.avatar createdAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Referral.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        referrals: referrals.map((r) => ({
          _id: r._id,
          referee: r.referee,
          status: r.status,
          totalEarned: r.totalEarned,
          payoutCount: r.payoutCount,
          firstQualifiedAt: r.firstQualifiedAt,
          expiresAt: r.status === 'pending' ? r.expiresAt : undefined,
          createdAt: r.createdAt,
        })),
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          totalRecords: total,
        },
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * GET /api/v1/referrals/stats
 * Aggregate summary for a referral dashboard widget: total earned,
 * counts by status, and lifetime payout count.
 */
exports.getStats = async (req, res) => {
  try {
    const referrerId = req.user._id;

    const [statusCounts, earningsAgg, recentPayouts] = await Promise.all([
      Referral.aggregate([
        { $match: { referrer: referrerId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Referral.aggregate([
        { $match: { referrer: referrerId } },
        { $group: { _id: null, totalEarned: { $sum: '$totalEarned' }, totalPayouts: { $sum: '$payoutCount' } } },
      ]),
      ReferralPayout.find({ recipient: referrerId, recipientType: 'referrer' })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('amount orderSubtotal rateApplied createdAt'),
    ]);

    const counts = statusCounts.reduce((acc, s) => {
      acc[s._id] = s.count;
      return acc;
    }, { pending: 0, active: 0, expired: 0 });

    res.json({
      success: true,
      data: {
        totalReferrals: counts.pending + counts.active + counts.expired,
        byStatus: counts,
        totalEarned: earningsAgg[0]?.totalEarned || 0,
        totalPayouts: earningsAgg[0]?.totalPayouts || 0,
        currency: REFERRAL_CONFIG.currency,
        recentPayouts,
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};