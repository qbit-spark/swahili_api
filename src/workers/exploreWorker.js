const { Worker } = require('bullmq');
const { bullMQConnection, getRedisClient, TTL, KEYS } = require('../config/redis');
const { JOBS } = require('../queues/exploreQueue');
const Product = require('../models/Product');
const Post = require('../models/Post');
const Video = require('../models/Video');
const AMA = require('../models/Ama');
const Event = require('../models/Event');
const Trending = require('../models/Trending');
const UserInterest = require('../models/UserInterest');

// ─── Scoring Weights per content type ────────────────────────────────────────
const WEIGHTS = {
  product: { trendVelocity: 0.30, categoryAffinity: 0.35, engagementRate: 0.20, freshness: 0.15 },
  post: { trendVelocity: 0.25, categoryAffinity: 0.20, engagementRate: 0.35, freshness: 0.20 },
  video: { trendVelocity: 0.30, categoryAffinity: 0.20, engagementRate: 0.30, freshness: 0.20 },
  ama: { trendVelocity: 0.15, categoryAffinity: 0.20, engagementRate: 0.25, freshness: 0.40 },
  // Events: freshness dominates — a past event should vanish from feed fast
  event: { trendVelocity: 0.15, categoryAffinity: 0.20, engagementRate: 0.15, freshness: 0.50 },
};

// ─── Shared Scoring Helpers ───────────────────────────────────────────────────

/**
 * Freshness: exponential decay — half-life varies by content type
 * AMAs decay fastest (4d) — closed AMAs should disappear quickly
 * Products decay slowest (14d) — catalogue items have longer shelf life
 */
const HALF_LIFE_DAYS = { product: 14, post: 7, video: 7, ama: 4, event: 2 };

const scoreFreshness = (createdAt, contentType) => {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  const halfLife = HALF_LIFE_DAYS[contentType] || 7;
  return parseFloat(Math.exp(-ageDays / halfLife).toFixed(4));
};

/**
 * Trend velocity: recent engagement relative to historical daily average
 * Each model stores engagement counters differently — normalized here
 */
const scoreTrendVelocity = (item, contentType) => {
  let total = 0, recent = 0;
  if (contentType === 'product') {
    total = item.views?.total || 0;
    recent = item.views?.unique || 0;
  } else if (contentType === 'post') {
    total = item.engagement?.views || 0;
    recent = (item.engagement?.likes || 0) + (item.engagement?.saves || 0);
  } else if (contentType === 'video') {
    total = item.engagement?.views || 0;
    recent = item.engagement?.uniqueViews || 0;
  } else if (contentType === 'event') {
    // Upcoming events get a boost, past events velocity drops to 0
    const isUpcoming = new Date(item.startsAt) > new Date();
    if (!isUpcoming) return 0;
    const rsvps = item.engagement?.rsvps || 0;
    return Math.min(rsvps / 100, 1);
  } else if (contentType === 'ama') {
    // For AMAs: open status is a velocity signal in itself
    const isOpen = item.status === 'open';
    const questions = item.engagement?.totalQuestions || 0;
    return isOpen ? Math.min(0.5 + (questions / 50) * 0.5, 1) : Math.min(questions / 100, 0.4);
  }
  const ageDays = Math.max(1, (Date.now() - new Date(item.createdAt).getTime()) / 86400000);
  const dailyAvg = total / ageDays;
  return parseFloat(Math.min(dailyAvg > 0 ? recent / dailyAvg : 0, 1).toFixed(4));
};

/**
 * Engagement rate: normalized 0-1 against soft caps per content type
 */
const ENGAGEMENT_CAPS = { product: 500, post: 1000, video: 2000, ama: 200, event: 500 };

const scoreEngagement = (item, contentType) => {
  let engagementValue = 0;
  if (contentType === 'product') {
    engagementValue = item.views?.unique || 0;
  } else if (contentType === 'post') {
    const e = item.engagement || {};
    engagementValue = (e.likes || 0) + (e.saves || 0) * 2 + (e.shares || 0) * 3 + (e.comments || 0);
  } else if (contentType === 'video') {
    const e = item.engagement || {};
    // Completions weighted 5x — strong quality signal
    engagementValue = (e.uniqueViews || 0) + (e.completionCount || 0) * 5 + (e.likes || 0) * 2;
  } else if (contentType === 'ama') {
    const e = item.engagement || {};
    engagementValue = (e.participants || 0) + (e.answeredCount || 0) * 3;
  } else if (contentType === 'event') {
    const e = item.engagement || {};
    engagementValue = (e.rsvps || 0) * 3 + (e.likes || 0) + (e.views || 0) * 0.1;
  }
  const cap = ENGAGEMENT_CAPS[contentType] || 500;
  return parseFloat(Math.min(engagementValue / cap, 1).toFixed(4));
};

const scoreCategoryAffinity = (item, userInterest, contentType) => {
  if (!userInterest || !item.category) return 0;
  const categoryId = item.category._id || item.category;
  return userInterest.affinityFor(categoryId);
};

/**
 * Master scorer — returns { score, breakdown }
 */
const scoreItem = (item, contentType, userInterest) => {
  const W = WEIGHTS[contentType];
  const trendVelocity = scoreTrendVelocity(item, contentType);
  const categoryAffinity = scoreCategoryAffinity(item, userInterest, contentType);
  const engagementRate = scoreEngagement(item, contentType);
  const freshness = scoreFreshness(item.createdAt, contentType);

  const score =
    trendVelocity * W.trendVelocity +
    categoryAffinity * W.categoryAffinity +
    engagementRate * W.engagementRate +
    freshness * W.freshness;

  return {
    score: parseFloat(score.toFixed(4)),
    breakdown: { trendVelocity, categoryAffinity, engagementRate, freshness },
  };
};

// ─── Cursor helpers ───────────────────────────────────────────────────────────
// Cursor format: "<score>_<id>"  e.g. "0.7821_64f3a..."
// Stored with each feed item so controller can decode without extra DB hit

const encodeCursor = (score, id) => `${score}_${id}`;

// ─── User interest loader (with Redis cache) ──────────────────────────────────
const loadUserInterest = async (userId, redis) => {
  const cached = await redis.get(KEYS.userInterests(userId)).catch(() => null);
  if (cached) {
    const map = JSON.parse(cached);
    return { affinityFor: (catId) => map[catId.toString()] || 0 };
  }
  const doc = await UserInterest.findOne({ user: userId });
  if (doc) {
    const interestMap = Object.fromEntries(doc.categoryAffinities);
    await redis.setex(KEYS.userInterests(userId), TTL.USER_INTERESTS, JSON.stringify(interestMap)).catch(() => { });
  }
  return doc;
};

// ─── Generic feed builder ─────────────────────────────────────────────────────
// Shared by all content types — fetches, scores, sorts, writes to Redis + DB (_exploreScore)

const buildFeed = async ({ model, contentType, filter, populateFields, userId, redis, cacheKey, ttl }) => {
  const userInterest = userId ? await loadUserInterest(userId, redis) : null;

  const items = await model
    .find(filter)
    .populate(populateFields)
    .lean();


  // const scored = items.map((item) => {
  //   const { score, breakdown } = scoreItem(item, contentType, userInterest);
  //   return { item, score, breakdown };
  // });

  const scored = items.map((item) => {
    const { score, breakdown } = scoreItem(item, contentType, userInterest);
    const sellerId = (item.seller?._id ?? item.seller)?.toString();
    const boost = boosts[sellerId] ?? 1.0;
    return {
      item,
      score: parseFloat((score * boost).toFixed(4)),
      breakdown: { ...breakdown, verificationBoost: boost },
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 200); // Store 200; paginate in memory from cache

  // Write _exploreScore back to DB in bulk so cursor-based DB fallback works
  const bulkOps = top.map(({ item, score }) => ({
    updateOne: {
      filter: { _id: item._id },
      update: { $set: { _exploreScore: score } },
    },
  }));
  if (bulkOps.length) await model.bulkWrite(bulkOps, { ordered: false });

  // Build cache payload — slim fields only, keep payload tight
  const feed = top.map(({ item, score, breakdown }) => ({
    _id: item._id,
    _score: score,
    _cursor: encodeCursor(score, item._id.toString()),
    _breakdown: breakdown,
    contentType,
    // Common fields
    seller: item.seller,
    shop: item.shop,
    category: item.category,
    status: item.status,
    createdAt: item.createdAt,
    // Type-specific fields
    ...(contentType === 'product' && {
      name: item.name, price: item.price, images: item.images, views: item.views,
    }),
    ...(contentType === 'post' && {
      caption: item.caption, images: item.images, engagement: item.engagement, taggedProducts: item.taggedProducts,
    }),
    ...(contentType === 'video' && {
      title: item.title, description: item.description, videoUrl: item.videoUrl,
      thumbnailUrl: item.thumbnailUrl, duration: item.duration, engagement: item.engagement,
      taggedProducts: item.taggedProducts,
    }),
    ...(contentType === 'ama' && {
      title: item.title, description: item.description,
      status: item.status, scheduledFor: item.scheduledFor,
      openedAt: item.openedAt, closedAt: item.closedAt,
      engagement: item.engagement,
      // Send top 3 pinned/answered questions as preview
      questionPreview: (item.questions || [])
        .filter((q) => q.isAnswered || q.isPinned)
        .slice(0, 3)
        .map((q) => ({ question: q.question, answer: q.answer, isPinned: q.isPinned })),
    }),
  }));

  await redis.setex(cacheKey, ttl, JSON.stringify(feed));
  console.log(`[Feed] Built ${feed.length} ${contentType} items → ${cacheKey}`);
  return feed;
};

// ─── Worker 1: Signal Ingest ──────────────────────────────────────────────────
const signalWorker = new Worker(
  'signal-ingest',
  async (job) => {
    const redis = getRedisClient();
    const { userId, categoryId } = job.data;

    // Helper: update UserInterest + bust relevant caches
    const applySignal = async (weight, feedKeyFn) => {
      if (userId && categoryId) {
        let interest = await UserInterest.findOne({ user: userId });
        if (!interest) interest = new UserInterest({ user: userId });
        interest.addSignal(categoryId, weight);
        await interest.save();
        await redis.del(KEYS.userInterests(userId));
        if (feedKeyFn) await redis.del(feedKeyFn(userId));
      }
    };

    const { requestFeedBuild, requestPostsFeedBuild,
      requestVideosFeedBuild, requestAmasFeedBuild } = require('../queues/exploreQueue');

    switch (job.name) {
      case JOBS.INGEST_VIEW:
        await applySignal(0.2, KEYS.userFeed);
        break;

      case JOBS.INGEST_PURCHASE:
        await applySignal(1.0, KEYS.userFeed);
        // Purchase = strong enough to proactively rebuild feed
        if (userId) await requestFeedBuild(userId);
        break;

      case JOBS.INGEST_POST_VIEW:
        await applySignal(0.15, KEYS.userPostsFeed);
        if (job.data.postId) {
          await Post.findByIdAndUpdate(job.data.postId, { $inc: { 'engagement.views': 1 } });
        }
        break;

      case JOBS.INGEST_POST_ENGAGE: {
        // Engagement weights: share > save > comment > like
        const engageWeights = { share: 0.6, save: 0.4, comment: 0.3, like: 0.2 };
        const w = engageWeights[job.data.engageType] || 0.2;
        await applySignal(w, KEYS.userPostsFeed);
        if (job.data.postId) {
          const incField = `engagement.${job.data.engageType}s`;
          await Post.findByIdAndUpdate(job.data.postId, { $inc: { [incField]: 1 } });
        }
        // Strong engage signal → rebuild their posts feed
        if (userId && (w >= 0.4)) await requestPostsFeedBuild(userId);
        break;
      }

      case JOBS.INGEST_VIDEO_VIEW:
        await applySignal(0.15, KEYS.userVideosFeed);
        if (job.data.videoId) {
          await Video.findByIdAndUpdate(job.data.videoId, {
            $inc: { 'engagement.views': 1, 'engagement.uniqueViews': 1 },
          });
        }
        break;

      case JOBS.INGEST_VIDEO_ENGAGE: {
        const w = job.data.completion ? 0.7 : 0.3;
        await applySignal(w, KEYS.userVideosFeed);
        if (job.data.videoId) {
          const inc = { [`engagement.${job.data.engageType}s`]: 1 };
          if (job.data.completion) inc['engagement.completionCount'] = 1;
          await Video.findByIdAndUpdate(job.data.videoId, { $inc: inc });
        }
        if (userId && job.data.completion) await requestVideosFeedBuild(userId);
        break;
      }

      case JOBS.INGEST_AMA_VIEW:
        await applySignal(0.1, KEYS.userAmasFeed);
        if (job.data.amaId) {
          await AMA.findByIdAndUpdate(job.data.amaId, { $inc: { 'engagement.views': 1 } });
        }
        break;


      case JOBS.INGEST_EVENT_VIEW:
        await applySignal(0.1, KEYS.userEventsFeed);
        if (job.data.eventId) {
          await Event.findByIdAndUpdate(job.data.eventId, { $inc: { 'engagement.views': 1 } });
        }
        break;

      case JOBS.INGEST_EVENT_ENGAGE: {
        const w = job.data.engageType === 'rsvp' ? 0.9 : 0.3;
        await applySignal(w, KEYS.userEventsFeed);
        if (userId && w >= 0.9) {
          const { requestEventsFeedBuild } = require('../queues/exploreQueue');
          await requestEventsFeedBuild(userId);
        }
        break;
      }
      case JOBS.INGEST_AMA_QUESTION:
        // Asking a question = highest AMA signal
        await applySignal(0.8, KEYS.userAmasFeed);
        if (job.data.amaId) {
          await AMA.findByIdAndUpdate(job.data.amaId, {
            $inc: { 'engagement.totalQuestions': 1, 'engagement.participants': 1 },
          });
        }
        if (userId) await requestAmasFeedBuild(userId);
        break;
    }

    console.log(`[Signal] ${job.name} processed — user:${userId || 'anon'}`);
  },
  { connection: bullMQConnection, concurrency: 15 }
);

// ─── Worker 2: Trend Scorer ───────────────────────────────────────────────────
const trendWorker = new Worker(
  'trend-scorer',
  async (job) => {
    const redis = getRedisClient();
    const { requestTrendingBuild, requestTrendingPostsBuild,
      requestTrendingVideosBuild, requestTrendingAmasBuild } = require('../queues/exploreQueue');

    if (job.name === JOBS.SCORE_TRENDING) {
      // Products (existing behaviour) — score and write to Redis per product
      const products = await Product.find({ status: 'active' })
        .select('_id views createdAt').lean();
      const pipeline = redis.pipeline();
      for (const p of products) {
        const v = scoreTrendVelocity(p, 'product');
        pipeline.setex(KEYS.trendScore(p._id.toString()), TTL.TREND_SCORES, v.toString());
      }
      await pipeline.exec();
      await requestTrendingBuild();
      console.log(`[Trend] Scored ${products.length} products`);
    }

    if (job.name === JOBS.SCORE_TRENDING_POSTS) {
      const posts = await Post.find({ status: 'published' })
        .select('_id engagement createdAt').lean();
      // Upsert a Trending snapshot doc — used as fallback when Redis is cold
      const items = posts
        .map((p) => ({ contentId: p._id, contentType: 'post', score: scoreTrendVelocity(p, 'post'), breakdown: {} }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 200);
      await Trending.findOneAndUpdate(
        { contentType: 'post' },
        { items, itemCount: items.length, computedAt: new Date() },
        { upsert: true }
      );
      await requestTrendingPostsBuild();
      console.log(`[Trend] Scored ${posts.length} posts`);
    }

    if (job.name === JOBS.SCORE_TRENDING_VIDEOS) {
      const videos = await Video.find({ status: 'published' })
        .select('_id engagement createdAt').lean();
      const items = videos
        .map((v) => ({ contentId: v._id, contentType: 'video', score: scoreTrendVelocity(v, 'video'), breakdown: {} }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 200);
      await Trending.findOneAndUpdate(
        { contentType: 'video' },
        { items, itemCount: items.length, computedAt: new Date() },
        { upsert: true }
      );
      await requestTrendingVideosBuild();
      console.log(`[Trend] Scored ${videos.length} videos`);
    }


    if (job.name === JOBS.SCORE_TRENDING_EVENTS) {
      const { requestTrendingEventsBuild } = require('../queues/exploreQueue');
      const upcoming = new Date();
      const events = await Event.find({
        status: 'published',
        startsAt: { $gte: upcoming },
      }).select('_id engagement createdAt startsAt').lean();

      const items = events
        .map((e) => ({ contentId: e._id, contentType: 'event', score: scoreTrendVelocity(e, 'event'), breakdown: {} }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 200);

      await Trending.findOneAndUpdate(
        { contentType: 'event' },
        { items, itemCount: items.length, computedAt: new Date() },
        { upsert: true }
      );
      await requestTrendingEventsBuild();
      console.log(`[Trend] Scored ${events.length} events`);
    }
    if (job.name === JOBS.SCORE_TRENDING_AMAS) {
      // Only surface open AMAs or recently closed (within 48h)
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const amas = await AMA.find({
        $or: [{ status: 'open' }, { status: 'closed', closedAt: { $gte: cutoff } }],
      }).select('_id engagement createdAt status').lean();
      const items = amas
        .map((a) => ({ contentId: a._id, contentType: 'ama', score: scoreTrendVelocity(a, 'ama'), breakdown: {} }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 200);
      await Trending.findOneAndUpdate(
        { contentType: 'ama' },
        { items, itemCount: items.length, computedAt: new Date() },
        { upsert: true }
      );
      await requestTrendingAmasBuild();
      console.log(`[Trend] Scored ${amas.length} AMAs`);
    }
  },
  { connection: bullMQConnection, concurrency: 1 }
);

// ─── Worker 3: Feed Builder ───────────────────────────────────────────────────
const feedWorker = new Worker(
  'feed-builder',
  async (job) => {
    const redis = getRedisClient();

    // Products feeds (existing)
    if (job.name === JOBS.BUILD_USER_FEED || job.name === JOBS.BUILD_TRENDING_FEED) {
      const isPersonalized = job.name === JOBS.BUILD_USER_FEED;
      const userId = isPersonalized ? job.data.userId : null;
      const cacheKey = isPersonalized ? KEYS.userFeed(userId) : KEYS.trendingFeed();

      await buildFeed({
        model: Product,
        contentType: 'product',
        filter: { status: 'active' },
        populateFields: [{ path: 'category', select: 'name' }, { path: 'shop', select: 'name' }],
        userId,
        redis,
        cacheKey,
        ttl: isPersonalized ? TTL.USER_FEED : TTL.TRENDING_FEED,
      });
    }

    // Posts feeds
    if (job.name === JOBS.BUILD_USER_POSTS_FEED || job.name === JOBS.BUILD_TRENDING_POSTS_FEED) {
      const isPersonalized = job.name === JOBS.BUILD_USER_POSTS_FEED;
      const userId = isPersonalized ? job.data.userId : null;
      const cacheKey = isPersonalized ? KEYS.userPostsFeed(userId) : KEYS.trendingPostsFeed();

      await buildFeed({
        model: Post,
        contentType: 'post',
        filter: { status: 'published' },
        populateFields: [
          { path: 'category', select: 'name' },
          { path: 'shop', select: 'name' },
          { path: 'seller', select: 'profile.firstName profile.lastName profile.avatar' },
        ],
        userId,
        redis,
        cacheKey,
        ttl: isPersonalized ? TTL.USER_FEED : TTL.TRENDING_FEED,
      });
    }

    // Videos feeds
    if (job.name === JOBS.BUILD_USER_VIDEOS_FEED || job.name === JOBS.BUILD_TRENDING_VIDEOS_FEED) {
      const isPersonalized = job.name === JOBS.BUILD_USER_VIDEOS_FEED;
      const userId = isPersonalized ? job.data.userId : null;
      const cacheKey = isPersonalized ? KEYS.userVideosFeed(userId) : KEYS.trendingVideosFeed();

      await buildFeed({
        model: Video,
        contentType: 'video',
        filter: { status: 'published' },
        populateFields: [
          { path: 'category', select: 'name' },
          { path: 'shop', select: 'name' },
          { path: 'seller', select: 'profile.firstName profile.lastName profile.avatar' },
        ],
        userId,
        redis,
        cacheKey,
        ttl: isPersonalized ? TTL.USER_FEED : TTL.TRENDING_FEED,
      });
    }


    // Events feeds
    if (job.name === JOBS.BUILD_USER_EVENTS_FEED || job.name === JOBS.BUILD_TRENDING_EVENTS_FEED) {
      const isPersonalized = job.name === JOBS.BUILD_USER_EVENTS_FEED;
      const userId = isPersonalized ? job.data.userId : null;
      const cacheKey = isPersonalized ? KEYS.userEventsFeed(userId) : KEYS.trendingEventsFeed();
      const now = new Date();

      await buildFeed({
        model: Event,
        contentType: 'event',
        filter: { status: 'published', startsAt: { $gte: now } },
        populateFields: [
          { path: 'category', select: 'name' },
          { path: 'shop', select: 'name' },
          { path: 'seller', select: 'profile.firstName profile.lastName profile.avatar' },
        ],
        userId,
        redis,
        cacheKey,
        ttl: isPersonalized ? TTL.USER_FEED : TTL.TRENDING_FEED,
      });
    }
    // AMAs feeds
    if (job.name === JOBS.BUILD_USER_AMAS_FEED || job.name === JOBS.BUILD_TRENDING_AMAS_FEED) {
      const isPersonalized = job.name === JOBS.BUILD_USER_AMAS_FEED;
      const userId = isPersonalized ? job.data.userId : null;
      const cacheKey = isPersonalized ? KEYS.userAmasFeed(userId) : KEYS.trendingAmasFeed();
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await buildFeed({
        model: AMA,
        contentType: 'ama',
        filter: {
          $or: [{ status: 'open' }, { status: 'closed', closedAt: { $gte: cutoff } }],
        },
        populateFields: [
          { path: 'category', select: 'name' },
          { path: 'shop', select: 'name' },
          { path: 'seller', select: 'profile.firstName profile.lastName profile.avatar' },
        ],
        userId,
        redis,
        cacheKey,
        ttl: isPersonalized ? TTL.USER_FEED : TTL.TRENDING_FEED,
      });
    }
  },
  { connection: bullMQConnection, concurrency: 5 }
);

// ─── Worker Error Handling ────────────────────────────────────────────────────
[signalWorker, trendWorker, feedWorker].forEach((worker) => {
  worker.on('failed', (job, err) => {
    console.error(`[Worker:${worker.name}] Job ${job?.id} failed:`, err.message);
  });
});

module.exports = { signalWorker, trendWorker, feedWorker };


