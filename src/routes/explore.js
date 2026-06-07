const express = require('express');
const router  = express.Router();
const exploreController = require('../controllers/exploreController');
const auth = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Explore
 *   description: Precomputed, cursor-paginated explore feed — 4 content tabs
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     CursorPagination:
 *       type: object
 *       properties:
 *         nextCursor:
 *           type: string
 *           description: Opaque base64url token. Pass as ?cursor= on next request. Null when no more pages.
 *         hasMore:
 *           type: boolean
 *         total:
 *           type: integer
 *           description: Total items in current ranked feed (not total in DB)
 *         limit:
 *           type: integer
 *     FeedMeta:
 *       type: object
 *       properties:
 *         source:
 *           type: string
 *           enum: [cache, freshly_built, fallback]
 *           description: cache = sub-5ms Redis hit. freshly_built = first visit, built on demand. fallback = Redis unavailable.
 *         personalized:
 *           type: boolean
 *         contentType:
 *           type: string
 *           enum: [product, post, video, ama]
 */

// ─── Tab feeds ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/explore/products:
 *   get:
 *     tags: [Explore]
 *     summary: Products tab — ranked product feed
 *     description: >
 *       Precomputed feed scored by trend velocity (30%), category affinity (35%),
 *       engagement (20%), freshness (15%). Personalized when authenticated.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Pagination cursor from previous response (omit for first page)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 40 }
 *     responses:
 *       200:
 *         description: Products feed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     feed: { type: array, items: { $ref: '#/components/schemas/Product' } }
 *                     pagination: { $ref: '#/components/schemas/CursorPagination' }
 *                     meta: { $ref: '#/components/schemas/FeedMeta' }
 *                 errors: { type: array, items: { type: string } }
 */
router.get('/products', auth, exploreController.getProductsFeed);

/**
 * @swagger
 * /api/v1/explore/posts:
 *   get:
 *     tags: [Explore]
 *     summary: Posts tab — ranked seller posts feed
 *     description: >
 *       Scored by trend velocity (25%), category affinity (20%),
 *       engagement (35% — likes/saves/shares/comments weighted), freshness (20%).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 40 }
 *     responses:
 *       200:
 *         description: Posts feed
 */
router.get('/posts', auth, exploreController.getPostsFeed);

/**
 * @swagger
 * /api/v1/explore/videos:
 *   get:
 *     tags: [Explore]
 *     summary: Videos tab — ranked short-form video feed
 *     description: >
 *       Scored by trend velocity (30%), category affinity (20%),
 *       engagement (30% — completion count weighted 5x), freshness (20%).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 40 }
 *     responses:
 *       200:
 *         description: Videos feed
 */
router.get('/videos', auth, exploreController.getVideosFeed);

/**
 * @swagger
 * /api/v1/explore/amas:
 *   get:
 *     tags: [Explore]
 *     summary: AMAs tab — open and recently closed AMA sessions
 *     description: >
 *       Scored by trend velocity (15%), category affinity (20%),
 *       engagement (25%), freshness (40% — AMAs decay in 4 days).
 *       Only surfaces open AMAs or those closed within the last 48h.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 40 }
 *     responses:
 *       200:
 *         description: AMAs feed
 */
router.get('/amas',   auth, exploreController.getAmasFeed);

/**
 * @swagger
 * /api/v1/explore/events:
 *   get:
 *     tags: [Explore]
 *     summary: Events tab — upcoming ranked events feed
 *     description: >
 *       Scored by trend velocity (15%), category affinity (20%),
 *       engagement (15% — RSVPs weighted 3x), freshness (50% — events decay in 2 days).
 *       Only surfaces published events with startsAt in the future.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 40 }
 *     responses:
 *       200:
 *         description: Events feed
 */
// router.get('/events', auth, exploreController.getEventsFeed);

// ─── Signal endpoint ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/explore/signal:
 *   post:
 *     tags: [Explore]
 *     summary: Emit a UI interaction signal
 *     description: >
 *       Records an explicit interaction from the explore screen.
 *       View/purchase signals on products are auto-emitted from productController.
 *       This endpoint handles: post likes/saves/shares/comments,
 *       video completions/likes, AMA question submissions.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contentId, contentType, signalType]
 *             properties:
 *               contentId:
 *                 type: string
 *               contentType:
 *                 type: string
 *                 enum: [product, post, video, ama, event]
 *               signalType:
 *                 type: string
 *                 enum: [view, like, save, share, comment, completion, question, rsvp]
 *     responses:
 *       200:
 *         description: Signal received and queued
 *       400:
 *         description: Missing or invalid fields
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Content not found
 */
router.post('/signal', auth, exploreController.emitSignal);

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/explore/status:
 *   get:
 *     tags: [Explore]
 *     summary: Feed system health — cache state + queue depths
 *     responses:
 *       200:
 *         description: Status snapshot for all 4 tabs
 */
router.get('/status', exploreController.getFeedStatus);

module.exports = router;