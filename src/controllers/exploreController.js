const { getRedisClient, KEYS, TTL } = require('../config/redis');
const {
  requestFeedBuild, requestTrendingBuild,
  requestPostsFeedBuild, requestTrendingPostsBuild,
  requestVideosFeedBuild, requestTrendingVideosBuild,
  requestAmasFeedBuild, requestTrendingAmasBuild,
  triggerTrendScoring, triggerAllTrendScoring,
} = require('../queues/exploreQueue');
const Product = require('../models/Product');
const Post    = require('../models/Post');
const Video   = require('../models/Video');
const AMA     = require('../models/AMA');

// ─── Cursor helpers ───────────────────────────────────────────────────────────
// Cursor = base64("<score>_<id>") — opaque to the client, stable across re-ranks

const encodeCursor = (score, id) =>
  Buffer.from(`${score}_${id}`).toString('base64url');

const decodeCursor = (cursor) => {
  try {
    const str = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = str.lastIndexOf('_');
    return { score: parseFloat(str.slice(0, sep)), id: str.slice(sep + 1) };
  } catch {
    return null;
  }
};

/**
 * Apply cursor-based pagination to a pre-sorted feed array from Redis.
 * Items are already sorted by score desc — find cursor position, slice forward.
 * Falls back to page 1 on invalid cursor (safe degradation).
 */
const paginateFeed = (feed, cursor, limit) => {
  let startIndex = 0;

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      // Find the first item whose score is strictly lower than the cursor score,
      // OR same score but id sorts after cursor id (tie-breaking)
      const idx = feed.findIndex(
        (item) =>
          item._score < decoded.score ||
          (item._score === decoded.score && item._id.toString() > decoded.id)
      );
      startIndex = idx === -1 ? feed.length : idx;
    }
  }

  const slice   = feed.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < feed.length;
  const nextCursor = hasMore
    ? encodeCursor(slice[slice.length - 1]._score, slice[slice.length - 1]._id.toString())
    : null;

  return { items: slice, nextCursor, hasMore, total: feed.length };
};

// ─── Generic tab handler ──────────────────────────────────────────────────────
// All 4 tabs (products, posts, videos, amas) share this logic.
// Only the Redis keys, rebuild functions, and DB fallback differ.

const SYNC_WAIT_MS = 4000;

const waitForKey = async (key, ms = SYNC_WAIT_MS) => {
  const redis = getRedisClient();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await redis.get(key);
    if (v) return JSON.parse(v);
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

/**
 * DB fallback — when Redis is cold and build timed out.
 * Uses _exploreScore index on each model for consistent ordering.
 */
const DB_FALLBACKS = {
  product: async (limit, afterScore, afterId) => {
    const q = { status: 'active' };
    if (afterScore != null) {
      q.$or = [
        { _exploreScore: { $lt: afterScore } },
        { _exploreScore: afterScore, _id: { $gt: afterId } },
      ];
    }
    return Product.find(q)
      .populate('category', 'name').populate('shop', 'name')
      .sort({ _exploreScore: -1, _id: 1 })
      .limit(limit).lean();
  },
  post: async (limit, afterScore, afterId) => {
    const q = { status: 'published' };
    if (afterScore != null) {
      q.$or = [
        { _exploreScore: { $lt: afterScore } },
        { _exploreScore: afterScore, _id: { $gt: afterId } },
      ];
    }
    return Post.find(q)
      .populate('category', 'name').populate('shop', 'name')
      .populate('seller', 'profile.firstName profile.lastName profile.avatar')
      .sort({ _exploreScore: -1, _id: 1 })
      .limit(limit).lean();
  },
  video: async (limit, afterScore, afterId) => {
    const q = { status: 'published' };
    if (afterScore != null) {
      q.$or = [
        { _exploreScore: { $lt: afterScore } },
        { _exploreScore: afterScore, _id: { $gt: afterId } },
      ];
    }
    return Video.find(q)
      .populate('category', 'name').populate('shop', 'name')
      .populate('seller', 'profile.firstName profile.lastName profile.avatar')
      .sort({ _exploreScore: -1, _id: 1 })
      .limit(limit).lean();
  },
  ama: async (limit, afterScore, afterId) => {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const q = {
      $or: [{ status: 'open' }, { status: 'closed', closedAt: { $gte: cutoff } }],
    };
    if (afterScore != null) {
      q.$and = [
        { $or: q.$or },
        { $or: [
          { _exploreScore: { $lt: afterScore } },
          { _exploreScore: afterScore, _id: { $gt: afterId } },
        ]},
      ];
      delete q.$or;
    }
    return AMA.find(q)
      .populate('category', 'name').populate('shop', 'name')
      .populate('seller', 'profile.firstName profile.lastName profile.avatar')
      .sort({ _exploreScore: -1, _id: 1 })
      .limit(limit).lean();
  },
};

/**
 * Core tab feed handler — used by all 4 tab endpoints
 *
 * @param {object} opts
 * @param {string} opts.contentType
 * @param {function} opts.userCacheKey  - fn(userId) → redis key
 * @param {function} opts.trendCacheKey - fn() → redis key
 * @param {function} opts.userBuildFn   - fn(userId) → Promise (queues a build)
 * @param {function} opts.trendBuildFn  - fn() → Promise
 */
const handleTabFeed = async (req, res, opts) => {
  try {
    const redis  = getRedisClient();
    const userId = req.user?._id?.toString() || null;
    const limit  = Math.min(40, Math.max(1, parseInt(req.query.limit) || 20));
    const cursor = req.query.cursor || null;

    const cacheKey = userId
      ? opts.userCacheKey(userId)
      : opts.trendCacheKey();

    // ── 1. Fast path: read from Redis, paginate in memory ────────────────────
    const cached = await redis.get(cacheKey);
    if (cached) {
      const feed = JSON.parse(cached);
      const { items, nextCursor, hasMore, total } = paginateFeed(feed, cursor, limit);

      return res.json({
        success: true,
        data: {
          feed: items,
          pagination: { nextCursor, hasMore, total, limit },
          meta: { source: 'cache', personalized: !!userId, contentType: opts.contentType },
        },
        errors: [],
      });
    }

    // ── 2. Cache miss: trigger build + wait ───────────────────────────────────
    console.log(`[Explore:${opts.contentType}] Cache miss — user:${userId || 'anon'}`);
    if (userId) await opts.userBuildFn(userId);
    else await opts.trendBuildFn();

    const freshFeed = await waitForKey(cacheKey);
    if (freshFeed) {
      const { items, nextCursor, hasMore, total } = paginateFeed(freshFeed, cursor, limit);
      return res.json({
        success: true,
        data: {
          feed: items,
          pagination: { nextCursor, hasMore, total, limit },
          meta: { source: 'freshly_built', personalized: !!userId, contentType: opts.contentType },
        },
        errors: [],
      });
    }

    // ── 3. DB fallback — Redis timed out ─────────────────────────────────────
    console.warn(`[Explore:${opts.contentType}] Build timed out — falling back to DB`);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const afterScore = decoded?.score ?? null;
    const afterId    = decoded?.id    ?? null;

    const items = await DB_FALLBACKS[opts.contentType](limit, afterScore, afterId);
    const hasMore = items.length === limit;
    const nextCursor = hasMore
      ? encodeCursor(items[items.length - 1]._exploreScore, items[items.length - 1]._id.toString())
      : null;

    return res.json({
      success: true,
      data: {
        feed: items,
        pagination: { nextCursor, hasMore, limit },
        meta: { source: 'fallback', personalized: false, contentType: opts.contentType },
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Tab Endpoints ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/explore/products
 * Query: ?cursor=<token>&limit=20
 */
exports.getProductsFeed = (req, res) =>
  handleTabFeed(req, res, {
    contentType:   'product',
    userCacheKey:  KEYS.userFeed,
    trendCacheKey: KEYS.trendingFeed,
    userBuildFn:   requestFeedBuild,
    trendBuildFn:  requestTrendingBuild,
  });

/**
 * GET /api/v1/explore/posts
 */
exports.getPostsFeed = (req, res) =>
  handleTabFeed(req, res, {
    contentType:   'post',
    userCacheKey:  KEYS.userPostsFeed,
    trendCacheKey: KEYS.trendingPostsFeed,
    userBuildFn:   requestPostsFeedBuild,
    trendBuildFn:  requestTrendingPostsBuild,
  });

/**
 * GET /api/v1/explore/videos
 */
exports.getVideosFeed = (req, res) =>
  handleTabFeed(req, res, {
    contentType:   'video',
    userCacheKey:  KEYS.userVideosFeed,
    trendCacheKey: KEYS.trendingVideosFeed,
    userBuildFn:   requestVideosFeedBuild,
    trendBuildFn:  requestTrendingVideosBuild,
  });

/**
 * GET /api/v1/explore/amas
 */
exports.getAmasFeed = (req, res) =>
  handleTabFeed(req, res, {
    contentType:   'ama',
    userCacheKey:  KEYS.userAmasFeed,
    trendCacheKey: KEYS.trendingAmasFeed,
    userBuildFn:   requestAmasFeedBuild,
    trendBuildFn:  requestTrendingAmasBuild,
  });

/**
 * POST /api/v1/explore/signal
 * Body: { contentId, contentType: 'product'|'post'|'video'|'ama', signalType: 'view'|'like'|'save'|'share'|'question'|'completion' }
 */
exports.emitSignal = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, errors: ['Auth required'], data: null });
    }
    const { contentId, contentType, signalType } = req.body;
    if (!contentId || !contentType || !signalType) {
      return res.status(400).json({
        success: false,
        errors: ['contentId, contentType, and signalType are required'],
        data: null,
      });
    }

    const models = { product: Product, post: Post, video: Video, ama: AMA };
    const model  = models[contentType];
    if (!model) {
      return res.status(400).json({ success: false, errors: ['Invalid contentType'], data: null });
    }

    const content = await model.findById(contentId).select('category').lean();
    if (!content) {
      return res.status(404).json({ success: false, errors: ['Content not found'], data: null });
    }

    const {
      emitViewSignal, emitPostViewSignal, emitPostEngageSignal,
      emitVideoViewSignal, emitVideoEngageSignal,
      emitAmaViewSignal, emitAmaQuestionSignal,
    } = require('../queues/exploreQueue');

    const uid = req.user._id;
    const cat = content.category;

    // Route to the right signal emitter
    const signalMap = {
      product: { view: () => emitViewSignal(contentId, uid, cat) },
      post: {
        view:    () => emitPostViewSignal(contentId, uid, cat),
        like:    () => emitPostEngageSignal(contentId, uid, cat, 'like'),
        save:    () => emitPostEngageSignal(contentId, uid, cat, 'save'),
        share:   () => emitPostEngageSignal(contentId, uid, cat, 'share'),
        comment: () => emitPostEngageSignal(contentId, uid, cat, 'comment'),
      },
      video: {
        view:       () => emitVideoViewSignal(contentId, uid, cat),
        like:       () => emitVideoEngageSignal(contentId, uid, cat, { engageType: 'like' }),
        save:       () => emitVideoEngageSignal(contentId, uid, cat, { engageType: 'save' }),
        completion: () => emitVideoEngageSignal(contentId, uid, cat, { completion: true }),
      },
      ama: {
        view:     () => emitAmaViewSignal(contentId, uid, cat),
        question: () => emitAmaQuestionSignal(contentId, uid, cat),
      },
    };

    const emitter = signalMap[contentType]?.[signalType];
    if (emitter) await emitter().catch((e) => console.error('Signal emit error:', e));

    res.json({ success: true, data: { received: true }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * GET /api/v1/explore/status — cache + queue health
 */
exports.getFeedStatus = async (req, res) => {
  try {
    const redis = getRedisClient();
    const { signalQueue, trendQueue, feedQueue } = require('../queues/exploreQueue');

    const [
      cachedProducts, cachedPosts, cachedVideos, cachedAmas,
      signalWaiting, trendWaiting, feedWaiting,
    ] = await Promise.all([
      redis.get(KEYS.trendingFeed()),
      redis.get(KEYS.trendingPostsFeed()),
      redis.get(KEYS.trendingVideosFeed()),
      redis.get(KEYS.trendingAmasFeed()),
      signalQueue.getWaitingCount(),
      trendQueue.getWaitingCount(),
      feedQueue.getWaitingCount(),
    ]);

    res.json({
      success: true,
      data: {
        cache: {
          products: { cached: !!cachedProducts, items: cachedProducts ? JSON.parse(cachedProducts).length : 0 },
          posts:    { cached: !!cachedPosts,    items: cachedPosts    ? JSON.parse(cachedPosts).length    : 0 },
          videos:   { cached: !!cachedVideos,   items: cachedVideos   ? JSON.parse(cachedVideos).length   : 0 },
          amas:     { cached: !!cachedAmas,     items: cachedAmas     ? JSON.parse(cachedAmas).length     : 0 },
        },
        queues: {
          signalIngest: { waiting: signalWaiting },
          trendScorer:  { waiting: trendWaiting },
          feedBuilder:  { waiting: feedWaiting },
        },
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};