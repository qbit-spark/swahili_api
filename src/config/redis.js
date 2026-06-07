const { Redis } = require('ioredis');

// Single shared Redis connection config
// BullMQ requires maxRetriesPerRequest: null
const bullMQConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
};

// Standard ioredis client for cache reads/writes
let redisClient = null;

const getRedisClient = () => {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 5) return null; // Stop retrying after 5 attempts
        return Math.min(times * 200, 2000);
      },
    });

    redisClient.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected');
    });
  }
  return redisClient;
};

// TTL constants (seconds)
const TTL = {
  USER_FEED: 30 * 60,        // 30 min — personalized feed per user
  TRENDING_FEED: 15 * 60,    // 15 min — global trending (cold start fallback)
  TREND_SCORES: 10 * 60,     // 10 min — raw trend score cache
  USER_INTERESTS: 60 * 60,   // 1 hr  — user interest vector
};

// Redis key namespaces
const KEYS = {
  // Products (original)
  userFeed:      (userId) => `explore:feed:products:${userId}`,
  trendingFeed:  ()       => `explore:trending:products`,
  trendScore:    (id)     => `explore:trend:${id}`,
  userInterests: (userId) => `explore:interests:${userId}`,
  // Posts
  userPostsFeed:     (userId) => `explore:feed:posts:${userId}`,
  trendingPostsFeed: ()       => `explore:trending:posts`,
  // Videos
  userVideosFeed:     (userId) => `explore:feed:videos:${userId}`,
  trendingVideosFeed: ()       => `explore:trending:videos`,
  // AMAs
  userAmasFeed:     (userId) => `explore:feed:amas:${userId}`,
  trendingAmasFeed: ()       => `explore:trending:amas`,
  // Events
  userEventsFeed:     (userId) => `explore:feed:events:${userId}`,
  trendingEventsFeed: ()       => `explore:trending:events`,
};

module.exports = { bullMQConnection, getRedisClient, TTL, KEYS };