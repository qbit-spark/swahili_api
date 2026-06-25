const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/searchController');

/**
 * @swagger
 * tags:
 *   name: Search
 *   description: Typo-tolerant product search backed by Meilisearch
 */

/**
 * @swagger
 * /api/v1/search/products:
 *   get:
 *     tags: [Search]
 *     summary: Search products with filters and sorting
 *     description: >
 *       Full-text typo-tolerant search. Empty q param = browse mode using
 *       only filters. When results are sparse (<3 hits), a `fallback` block
 *       is included with similar-category or popular alternatives.
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Search text. Typo-tolerant — "iphoone" matches "iphone".
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [relevance, newest, price_asc, price_desc, most_viewed, top_rated]
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: city
 *         schema: { type: string }
 *       - in: query
 *         name: condition
 *         schema: { type: string, enum: [new, used, refurbished] }
 *       - in: query
 *         name: verifiedOnly
 *         schema: { type: boolean }
 *       - in: query
 *         name: inStockOnly
 *         schema: { type: boolean }
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: minRating
 *         schema: { type: number }
 *       - in: query
 *         name: sellerTier
 *         schema: { type: string, enum: [none, blue, green, gold] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 40 }
 *     responses:
 *       200:
 *         description: Search results with optional fallback suggestions
 */
router.get('/products', ctrl.search);

/**
 * @swagger
 * /api/v1/search/suggest:
 *   get:
 *     tags: [Search]
 *     summary: Autocomplete suggestions for search-as-you-type
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 6, maximum: 10 }
 *     responses:
 *       200:
 *         description: Suggestion list
 */
router.get('/suggest', ctrl.suggest);

/**
 * @swagger
 * /api/v1/search/filters:
 *   get:
 *     tags: [Search]
 *     summary: Get available filter options for building filter UI
 *     responses:
 *       200:
 *         description: Categories, conditions, sort options, seller tiers
 */
router.get('/filters', ctrl.getFilterOptions);

module.exports = router;