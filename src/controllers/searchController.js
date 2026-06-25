const { searchProducts, suggestProducts } = require('../services/searchService');
const Category = require('../models/Category');

/**
 * Reshapes a raw Meilisearch hit into the same shape your /products
 * endpoint already returns, so any shared ProductCard component on the
 * frontend works identically whether the data came from search or from
 * the normal products list — no branching logic needed on the client.
 *
 * Deliberately thin: name, price, images, category, rating, stock status
 * for the result card itself. Full description, exact stock count, full
 * shop object, and views are intentionally left for the detail screen's
 * own GET /products/:id call — those fields change more often than
 * search index refreshes happen, so showing them here risks displaying
 * stale data (e.g. "5 in stock" after the last unit just sold).
 */
const reshapeSearchHit = (hit) => ({
  _id:      hit.id,
  name:     hit.name,
  price:    hit.price,
  images:   hit.images,
  category: {
    _id:  hit.category,
    name: hit.categoryName,
  },
  shop: hit.shopId, // matches /products' shape: shop is just an ID string there too
  condition: hit.condition,
  inStock:   hit.inStock,
  ratings: {
    average: hit.avgRating,
    count:   hit.ratingCount,
  },
  // Highlighted snippets, if present — useful for "matched on description" UI
  ...(hit._formatted && { _formatted: hit._formatted }),
});

// ─── GET /api/v1/search/products ─────────────────────────────────────────────

exports.search = async (req, res) => {
  try {
    const {
      q = '',
      sort = 'relevance',
      category, city, condition, verifiedOnly, inStockOnly,
      minPrice, maxPrice, minRating, sellerTier,
      page = 1, limit = 20,
    } = req.query;

    const result = await searchProducts({
      query: q,
      sort,
      filters: {
        category, city, condition, verifiedOnly, inStockOnly,
        minPrice, maxPrice, minRating, sellerTier,
      },
      page: parseInt(page),
      limit: Math.min(40, parseInt(limit)),
    });

    res.json({
      success: true,
      data: {
        products: result.hits.map(reshapeSearchHit),
        pagination: {
          currentPage: result.page,
          totalPages:  result.totalPages,
          totalHits:   result.totalHits,
          limit:       result.limit,
        },
        meta: {
          query: result.query,
          processingTimeMs: result.processingTimeMs,
          sort,
        },
        fallback: result.fallback ? {
          reason: result.fallback.reason,
          hits:   result.fallback.hits.map(reshapeSearchHit),
        } : null,
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── GET /api/v1/search/suggest ───────────────────────────────────────────────

exports.suggest = async (req, res) => {
  try {
    const { q, limit = 6 } = req.query;
    if (!q?.trim()) {
      return res.json({ success: true, data: { suggestions: [] }, errors: [] });
    }

    const hits = await suggestProducts(q, Math.min(10, parseInt(limit)));

    res.json({
      success: true,
      data: { suggestions: hits.map(reshapeSearchHit) },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── GET /api/v1/search/filters ───────────────────────────────────────────────

exports.getFilterOptions = async (req, res) => {
  try {
    const categories = await Category.find().select('name').lean();

    res.json({
      success: true,
      data: {
        categories: categories.map((c) => ({ id: c._id, name: c.name })),
        conditions: ['new', 'used', 'refurbished'],
        sortOptions: [
          { value: 'relevance',   label: 'Relevance' },
          { value: 'newest',      label: 'Newest First' },
          { value: 'price_asc',   label: 'Price: Low to High' },
          { value: 'price_desc',  label: 'Price: High to Low' },
          { value: 'most_viewed', label: 'Most Viewed' },
          { value: 'top_rated',   label: 'Top Rated' },
        ],
        sellerTiers: ['none', 'blue', 'green', 'gold'],
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};