const Shop = require('../models/Shop');

/**
 * sellerOrAdmin middleware
 * ─────────────────────────
 * Protects content-creation routes.
 * Passes if:
 *   - user is ADMIN (no shop required), OR
 *   - user is SELLER with an existing shop
 *
 * Attaches req.shop for downstream controllers so they don't re-query.
 * Must be used AFTER the auth middleware.
 *
 * Usage:
 *   router.post('/', auth, sellerOrAdmin, controller.create);
 */
const sellerOrAdmin = async (req, res, next) => {
  try {
    const { userType } = req.user;

    if (userType === 'ADMIN') {
      req.shop = null;
      return next();
    }

    if (userType !== 'SELLER') {
      return res.status(403).json({
        success: false,
        errors: ['Only sellers and admins can create content'],
        data: null,
      });
    }

    const shop = await Shop.findOne({ owner: req.user.id });

    if (!shop) {
      return res.status(403).json({
        success: false,
        errors: ['You must create a shop before posting content'],
        data: null,
      });
    }

    req.shop = shop;
    return next();
  } catch (err) {
    res.status(500).json({ success: false, errors: [err.message], data: null });
  }
};

module.exports = sellerOrAdmin;