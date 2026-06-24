const { SellerVerification, UNVERIFIED_LISTING_CAP } = require('../models/SellerVerification');
const Product = require('../models/Product');
const Shop    = require('../models/Shop');

/**
 * enforceListingCap middleware
 * ──────────────────────────────
 * Drop this in front of your existing createProduct route, after auth.
 * Blocks the request with a clear error if the seller has hit their
 * tier's product cap. Unverified sellers get UNVERIFIED_LISTING_CAP (50).
 *
 * Usage:
 *   router.post('/', auth, enforceListingCap, productController.createProduct);
 */
const enforceListingCap = async (req, res, next) => {
  try {
    const shop = await Shop.findOne({ owner: req.user.id });
    if (!shop) {
      return res.status(400).json({
        success: false,
        errors: ['You must create a shop before adding products'],
        data: null,
      });
    }

    const record = await SellerVerification.findOne({ seller: req.user.id });
    const cap = record ? record.getListingCap() : UNVERIFIED_LISTING_CAP;

    if (cap === Infinity) return next(); // Gold tier — no cap

    const currentCount = await Product.countDocuments({ shop: shop._id });

    if (currentCount >= cap) {
      return res.status(403).json({
        success: false,
        errors: [
          `You've reached your listing limit of ${cap} products. ` +
          `Apply for a higher verification badge to list more.`,
        ],
        data: {
          currentCount,
          cap,
          currentTier: record?.currentTier ?? 'none',
        },
      });
    }

    next();
  } catch (err) {
    res.status(500).json({ success: false, errors: [err.message], data: null });
  }
};

module.exports = enforceListingCap;