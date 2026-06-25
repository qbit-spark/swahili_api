const { SellerVerification } = require('../models/SellerVerification');

/**
 * Transforms a single Product document (must be .populate()'d on category
 * and shop) into the flat shape Meilisearch indexes.
 *
 * Denormalizing category/shop fields here is deliberate — Meilisearch has
 * no concept of joins, so anything you want to filter/sort/search by has
 * to live directly on the indexed document.
 */
const toSearchDocument = async (product, verificationTierMap = null) => {
  const shop     = product.shop;
  const category = product.category;

  // Allow callers to pass a pre-fetched tier map (bulk reindex) to avoid
  // an N+1 query; falls back to a single lookup for one-off syncs.
  let sellerTier = 'none';
  if (verificationTierMap && shop?._id) {
    sellerTier = verificationTierMap[shop._id.toString()] ?? 'none';
  } else if (shop?._id) {
    const record = await SellerVerification.findOne({ shop: shop._id }).select('currentTier').lean();
    sellerTier = record?.currentTier ?? 'none';
  }

  return {
    id:          product._id.toString(), // Meilisearch primary key — must be a string
    name:        product.name,
    description: product.description || '',
    price:       product.price,
    images:      product.images || [],
    tags:        product.tags || [],
    condition:   product.condition || 'new',
    status:      product.status,
    inStock:     (product.stock ?? 0) > 0,
    stock:       product.stock ?? 0,

    category:     category?._id?.toString() ?? null,
    categoryName: category?.name ?? '',

    shopId:           shop?._id?.toString() ?? null,
    shopName:         shop?.name ?? '',
    city:             shop?.address?.city ?? '',
    isVerifiedSeller: shop?.verificationStatus?.isVerified ?? false,
    sellerTier,

    views:       product.views?.total ?? 0,
    avgRating:   product.ratings?.average ?? 0,
    ratingCount: product.ratings?.count ?? 0,

    createdAt:     new Date(product.createdAt).getTime(), // epoch ms — sortable
    _exploreScore: product._exploreScore ?? 0,
  };
};

/**
 * Bulk variant — fetches verification tiers for all shops in one query
 * instead of N+1, used by the full reindex script and batch sync jobs.
 */
const toSearchDocuments = async (products) => {
  const shopIds = [...new Set(
    products.map((p) => p.shop?._id?.toString()).filter(Boolean)
  )];

  const records = await SellerVerification.find({
    shop: { $in: shopIds },
  }).select('shop currentTier').lean();

  const tierMap = {};
  records.forEach((r) => { tierMap[r.shop.toString()] = r.currentTier; });

  return Promise.all(products.map((p) => toSearchDocument(p, tierMap)));
};

module.exports = { toSearchDocument, toSearchDocuments };