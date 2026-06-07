const { Queue } = require('bullmq');
const { bullMQConnection } = require('../config/redis');

// ─── Queue: Signal Ingest ─────────────────────────────────────────────────────
// Fired on every user action: view, purchase, save
// Workers update UserInterest vectors and invalidate stale feeds
const signalQueue = new Queue('signal-ingest', {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: { count: 100 },  // Keep last 100 for debugging
    removeOnFail: { count: 50 },
  },
});

// ─── Queue: Trend Scorer ──────────────────────────────────────────────────────
// Runs on a repeatable schedule (every 15 min) + triggered on spikes
// Computes trend_velocity for all active products
const trendQueue = new Queue('trend-scorer', {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 1000 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 20 },
  },
});

// ─── Queue: Feed Builder ──────────────────────────────────────────────────────
// Builds and caches ranked explore feed for a specific user
// Triggered: on feed cache miss, after significant signal, on schedule
const feedQueue = new Queue('feed-builder', {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 50 },
  },
});

// ─── Job Type Constants ───────────────────────────────────────────────────────
const JOBS = {
  // signal-ingest — product signals (existing)
  INGEST_VIEW: 'ingest:view',
  INGEST_PURCHASE: 'ingest:purchase',

  // signal-ingest — new content type signals
  INGEST_POST_VIEW: 'ingest:post:view',
  INGEST_POST_ENGAGE: 'ingest:post:engage',    // like, save, share
  INGEST_VIDEO_VIEW: 'ingest:video:view',
  INGEST_VIDEO_ENGAGE: 'ingest:video:engage',   // like, save, completion
  INGEST_AMA_VIEW: 'ingest:ama:view',
  INGEST_AMA_QUESTION: 'ingest:ama:question',   // strongest AMA signal

  // trend-scorer — one job per content type
  SCORE_TRENDING: 'score:trending',        // products (existing)
  SCORE_TRENDING_POSTS: 'score:trending:posts',
  SCORE_TRENDING_VIDEOS: 'score:trending:videos',
  SCORE_TRENDING_AMAS: 'score:trending:amas',

  // feed-builder — per user per tab + global trending per tab
  BUILD_USER_FEED: 'build:user-feed',           // products (existing)
  BUILD_TRENDING_FEED: 'build:trending-feed',       // products (existing)
  BUILD_USER_POSTS_FEED: 'build:user-feed:posts',
  BUILD_USER_VIDEOS_FEED: 'build:user-feed:videos',
  BUILD_USER_AMAS_FEED: 'build:user-feed:amas',
  BUILD_TRENDING_POSTS_FEED: 'build:trending-feed:posts',
  BUILD_TRENDING_VIDEOS_FEED: 'build:trending-feed:videos',
  BUILD_TRENDING_AMAS_FEED: 'build:trending-feed:amas',
  BUILD_USER_EVENTS_FEED: 'build:user-feed:events',
  BUILD_TRENDING_EVENTS_FEED: 'build:trending-feed:events',
  SCORE_TRENDING_EVENTS: 'score:trending:events',
  INGEST_EVENT_VIEW: 'ingest:event:view',
  INGEST_EVENT_ENGAGE: 'ingest:event:engage',
};

// ─── Helpers to enqueue jobs ──────────────────────────────────────────────────

/**
 * Emit a view signal — called from productController after a product is viewed
 * Low priority; non-blocking for the HTTP response
 */
const emitViewSignal = (productId, userId, categoryId) =>
  signalQueue.add(
    JOBS.INGEST_VIEW,
    { productId, userId, categoryId },
    { priority: 10 }
  );

/**
 * Emit a purchase signal — called from order controller after successful purchase
 * Higher weight than view, higher queue priority
 */
const emitPurchaseSignal = (productId, userId, categoryId) =>
  signalQueue.add(
    JOBS.INGEST_PURCHASE,
    { productId, userId, categoryId },
    { priority: 5 }
  );

/**
 * Request a personalized feed rebuild for a specific user
 * Called when Redis cache misses or significant new signal arrives
 */
const requestFeedBuild = (userId) =>
  feedQueue.add(
    JOBS.BUILD_USER_FEED,
    { userId },
    {
      // Deduplicate: if a build for this user is already queued, don't add another
      jobId: `feed:${userId}`,
      priority: 3,
    }
  );

/**
 * Request a trending feed rebuild (anonymous/cold-start users)
 */
const requestTrendingBuild = () =>
  feedQueue.add(
    JOBS.BUILD_TRENDING_FEED,
    {},
    { jobId: 'trending-feed', priority: 8 }
  );

/**
 * Trigger a full trend scoring run across all active products
 */
const triggerTrendScoring = () =>
  trendQueue.add(JOBS.SCORE_TRENDING, {}, { jobId: 'trend-scoring-run' });

// ─── Content signal emitters ──────────────────────────────────────────────────

/**
 * Post signals — called from postController (fire-and-forget)
 * engage type: 'like' | 'save' | 'share' | 'comment'
 */
const emitPostViewSignal = (postId, userId, categoryId) =>
  signalQueue.add(JOBS.INGEST_POST_VIEW, { postId, userId, categoryId }, { priority: 10 });

const emitPostEngageSignal = (postId, userId, categoryId, engageType) =>
  signalQueue.add(JOBS.INGEST_POST_ENGAGE, { postId, userId, categoryId, engageType }, { priority: 6 });

/**
 * Video signals — called from videoController (fire-and-forget)
 * completion: boolean — did user watch to the end?
 */
const emitVideoViewSignal = (videoId, userId, categoryId) =>
  signalQueue.add(JOBS.INGEST_VIDEO_VIEW, { videoId, userId, categoryId }, { priority: 10 });

const emitVideoEngageSignal = (videoId, userId, categoryId, { completion = false, engageType } = {}) =>
  signalQueue.add(JOBS.INGEST_VIDEO_ENGAGE, { videoId, userId, categoryId, completion, engageType }, { priority: 6 });

/**
 * AMA signals — called from amaController (fire-and-forget)
 * Asking a question is the strongest AMA signal (priority 4)
 */
const emitAmaViewSignal = (amaId, userId, categoryId) =>
  signalQueue.add(JOBS.INGEST_AMA_VIEW, { amaId, userId, categoryId }, { priority: 10 });

const emitAmaQuestionSignal = (amaId, userId, categoryId) =>
  signalQueue.add(JOBS.INGEST_AMA_QUESTION, { amaId, userId, categoryId }, { priority: 4 });

// ─── Per-tab feed build helpers ───────────────────────────────────────────────

const requestPostsFeedBuild = (userId) =>
  feedQueue.add(JOBS.BUILD_USER_POSTS_FEED, { userId }, { jobId: `feed:posts:${userId}`, priority: 3 });

const requestVideosFeedBuild = (userId) =>
  feedQueue.add(JOBS.BUILD_USER_VIDEOS_FEED, { userId }, { jobId: `feed:videos:${userId}`, priority: 3 });

const requestAmasFeedBuild = (userId) =>
  feedQueue.add(JOBS.BUILD_USER_AMAS_FEED, { userId }, { jobId: `feed:amas:${userId}`, priority: 3 });

const requestTrendingPostsBuild = () =>
  feedQueue.add(JOBS.BUILD_TRENDING_POSTS_FEED, {}, { jobId: 'trending-feed:posts', priority: 8 });

const requestTrendingVideosBuild = () =>
  feedQueue.add(JOBS.BUILD_TRENDING_VIDEOS_FEED, {}, { jobId: 'trending-feed:videos', priority: 8 });

const requestTrendingAmasBuild = () =>
  feedQueue.add(JOBS.BUILD_TRENDING_AMAS_FEED, {}, { jobId: 'trending-feed:amas', priority: 8 });

/**
 * Convenience: rebuild all trending feeds at once
 * Called from the scheduler on server startup and on schedule
 */
const triggerAllTrendScoring = () =>
  Promise.all([
    trendQueue.add(JOBS.SCORE_TRENDING, {}, { jobId: 'trend-scoring:products' }),
    trendQueue.add(JOBS.SCORE_TRENDING_POSTS, {}, { jobId: 'trend-scoring:posts' }),
    trendQueue.add(JOBS.SCORE_TRENDING_VIDEOS, {}, { jobId: 'trend-scoring:videos' }),
    trendQueue.add(JOBS.SCORE_TRENDING_AMAS, {}, { jobId: 'trend-scoring:amas' }),
  ]);


// Events
const emitEventViewSignal = (eventId, userId, categoryId) =>
  signalQueue.add(JOBS.INGEST_EVENT_VIEW, { eventId, userId, categoryId }, { priority: 10 });

const emitEventEngageSignal = (eventId, userId, categoryId, engageType) =>
  signalQueue.add(JOBS.INGEST_EVENT_ENGAGE, { eventId, userId, categoryId, engageType }, { priority: 6 });

const requestEventsFeedBuild = (userId) =>
  feedQueue.add(JOBS.BUILD_USER_EVENTS_FEED, { userId }, { jobId: `feed:events:${userId}`, priority: 3 });

const requestTrendingEventsBuild = () =>
  feedQueue.add(JOBS.BUILD_TRENDING_EVENTS_FEED, {}, { jobId: 'trending-feed:events', priority: 8 });

module.exports = {
  signalQueue,
  trendQueue,
  feedQueue,
  JOBS,
  // Products (existing)
  emitViewSignal,
  emitPurchaseSignal,
  requestFeedBuild,
  requestTrendingBuild,
  triggerTrendScoring,
  // Posts
  emitPostViewSignal,
  emitPostEngageSignal,
  requestPostsFeedBuild,
  requestTrendingPostsBuild,
  // Videos
  emitVideoViewSignal,
  emitVideoEngageSignal,
  requestVideosFeedBuild,
  requestTrendingVideosBuild,
  // AMAs
  emitAmaViewSignal,
  emitAmaQuestionSignal,
  requestAmasFeedBuild,
  requestTrendingAmasBuild,
  // Combined
  triggerAllTrendScoring,
  // Events
  emitEventViewSignal,
  emitEventEngageSignal,
  requestEventsFeedBuild,
  requestTrendingEventsBuild,
};