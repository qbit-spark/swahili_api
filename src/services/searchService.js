const { client, PRODUCTS_INDEX } = require('../config/meilisearch');

// ─── Sort option mapping ──────────────────────────────────────────────────────
const SORT_OPTIONS = {
  newest: ['createdAt:desc'],
  price_asc: ['price:asc'],
  price_desc: ['price:desc'],
  most_viewed: ['views:desc'],
  top_rated: ['avgRating:desc'],
  relevance: [], // empty = Meilisearch's default relevance ranking
};

// Below this result count, the search is considered "sparse" and triggers
// the category-fallback behavior.
const SPARSE_RESULT_THRESHOLD = 3;

// ─── Filter builder ───────────────────────────────────────────────────────────
//
// NOTE: Product has no status/visibility field in the real schema (verified
// against the actual ProductSchema — only name, description, price, category,
// shop, images, stock, ratings, condition, views, createdAt exist). The
// previous version of this function always appended `status = "active"`,
// which matched nothing since the field doesn't exist on any indexed
// document — that would have zeroed out every single search result.
// Removed entirely. If a visibility/pause feature gets added to Product
// later, add the equivalent clause back in here.
const buildFilterExpression = (filters = {}) => {
  const clauses = [];

  if (filters.category) clauses.push(`category = "${filters.category}"`);
  if (filters.city) clauses.push(`city = "${filters.city}"`);
  if (filters.condition) clauses.push(`condition = "${filters.condition}"`);
  if (filters.verifiedOnly === true || filters.verifiedOnly === 'true')
    clauses.push(`isVerifiedSeller = true`);
  if (filters.inStockOnly === true || filters.inStockOnly === 'true')
    clauses.push(`inStock = true`);
  if (filters.minPrice !== undefined) clauses.push(`price >= ${parseFloat(filters.minPrice)}`);
  if (filters.maxPrice !== undefined) clauses.push(`price <= ${parseFloat(filters.maxPrice)}`);
  if (filters.minRating !== undefined) clauses.push(`avgRating >= ${parseFloat(filters.minRating)}`);
  if (filters.sellerTier) clauses.push(`sellerTier = "${filters.sellerTier}"`);

  return clauses.join(' AND ');
};

/**
 * Core search function.
 */
const searchProducts = async ({
  query = '',
  filters = {},
  sort = 'relevance',
  page = 1,
  limit = 20,
} = {}) => {
  const index = client.index(PRODUCTS_INDEX);
  const offset = (page - 1) * limit;
  const filterExpr = buildFilterExpression(filters);
  const sortArr = SORT_OPTIONS[sort] ?? [];

  const primaryResult = await index.search(query, {
    filter: filterExpr || undefined,
    sort: sortArr.length ? sortArr : undefined,
    limit,
    offset,
    attributesToHighlight: ['name', 'description'],
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
  });

  // ── Sparse result fallback ──────────────────────────────────────────────
  let fallbackResults = null;
  let fallbackReason = null;

  if (query.trim() && primaryResult.hits.length < SPARSE_RESULT_THRESHOLD) {
    const topHitCategory = primaryResult.hits[0]?.category;

    if (topHitCategory) {
      const categoryFilter = buildFilterExpression({ ...filters, category: topHitCategory });
      const widened = await index.search('', {
        filter: categoryFilter || undefined,
        sort: ['views:desc'],
        limit: limit - primaryResult.hits.length,
      });
      fallbackResults = widened.hits;
      fallbackReason = 'similar_category';
    } else {
      const noQueryFilter = buildFilterExpression(filters);
      const popular = await index.search('', {
        filter: noQueryFilter || undefined,
        sort: ['views:desc'],
        limit,
      });
      fallbackResults = popular.hits;
      fallbackReason = 'popular_alternatives';
    }
  }

  return {
    hits: primaryResult.hits,
    totalHits: primaryResult.estimatedTotalHits,
    page,
    limit,
    totalPages: Math.ceil(primaryResult.estimatedTotalHits / limit),
    processingTimeMs: primaryResult.processingTimeMs,
    query: primaryResult.query,
    fallback: fallbackResults ? {
      reason: fallbackReason,
      hits: fallbackResults,
    } : null,
  };
};

const suggestProducts = async (query, limit = 6) => {
  const index = client.index(PRODUCTS_INDEX);
  const result = await index.search(query, {
    limit,
    attributesToRetrieve: ['id', 'name', 'images', 'price', 'categoryName'],
  });
  return result.hits;
};

module.exports = { searchProducts, suggestProducts, buildFilterExpression, SORT_OPTIONS };