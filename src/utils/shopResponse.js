const { SellerVerification } = require('../models/SellerVerification');

const ensureShopVerificationTier = async (shop) => {
  if (!shop || typeof shop !== 'object') return shop;

  const normalizedShop = shop.toObject ? shop.toObject({ virtuals: true }) : { ...shop };
  const existingTier = normalizedShop.verificationTier
    ?? normalizedShop.verificationStatus?.verificationTier
    ?? null;

  if (existingTier) {
    normalizedShop.verificationTier = existingTier;
    if (normalizedShop.verificationStatus && typeof normalizedShop.verificationStatus === 'object') {
      normalizedShop.verificationStatus.verificationTier = existingTier;
    }
    if (shop && typeof shop === 'object') {
      shop.verificationTier = existingTier;
      shop.verificationStatus = shop.verificationStatus || {};
      shop.verificationStatus.verificationTier = existingTier;
    }
    return normalizedShop;
  }

  const shopId = normalizedShop._id || shop._id;
  const ownerId = normalizedShop.owner?._id || normalizedShop.owner || shop.owner;

  let record = null;
  if (shopId) {
    record = await SellerVerification.findOne({ shop: shopId }).select('currentTier').lean();
  }
  if (!record && ownerId) {
    record = await SellerVerification.findOne({ seller: ownerId }).select('currentTier').lean();
  }

  const verificationTier = record?.currentTier ?? 'none';
  normalizedShop.verificationTier = verificationTier;
  normalizedShop.verificationStatus = {
    ...(normalizedShop.verificationStatus || {}),
    verificationTier,
  };

  if (shop && typeof shop === 'object') {
    shop.verificationTier = verificationTier;
    shop.verificationStatus = shop.verificationStatus || {};
    shop.verificationStatus.verificationTier = verificationTier;
  }

  return normalizedShop;
};

const enrichResponseItem = async (item, shopKey = 'shop') => {
  if (!item || typeof item !== 'object') return item;

  if (item[shopKey]) {
    item[shopKey] = await ensureShopVerificationTier(item[shopKey]);
  }

  return item;
};

module.exports = {
  ensureShopVerificationTier,
  enrichResponseItem,
};
