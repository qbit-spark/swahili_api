const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const { bullMQConnection } = require('../config/redis');
const { JOBS } = require('../queues/searchSyncQueue');
const { client, PRODUCTS_INDEX } = require('../config/meilisearch');
const Product = require('../models/Product');
const { toSearchDocument, toSearchDocuments } = require('../services/productSearchTransform');

/**
 * ROOT CAUSE of "products.find() buffering timed out after 10000ms":
 *
 * This worker file is required at the very top of server.js, BEFORE
 * connectDB() is even called. BullMQ workers start polling Redis for jobs
 * immediately on require — they don't wait for your app's initializeApp()
 * to finish. So when the server boots and initializeApp() calls
 * triggerFullReindex() right after connectDB() resolves, there's a real
 * race: Mongoose's `await connectDB()` can resolve slightly before the
 * underlying driver has finished its initial topology discovery against
 * Atlas's multiple shards, and if a BullMQ job happens to get picked up
 * in that narrow window, Mongoose buffers the query waiting for a
 * connection that takes a moment longer to actually be ready — and times
 * out after the default 10s buffer window.
 *
 * Fix: explicitly wait for mongoose.connection.readyState === 1 (connected)
 * before running ANY query inside this worker, with a real timeout and
 * clear error if it never happens. This makes the worker robust regardless
 * of process boot order — it no longer assumes connectDB() having resolved
 * means queries are safe to run yet.
 */
const waitForMongoConnection = async (timeoutMs = 20000) => {
  if (mongoose.connection.readyState === 1) return; // already connected

  console.log('[SearchSync] Waiting for MongoDB connection before proceeding...');
  const start = Date.now();

  while (mongoose.connection.readyState !== 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `MongoDB connection not ready after ${timeoutMs}ms (readyState=${mongoose.connection.readyState}). ` +
        `Job aborted rather than letting Mongoose buffer indefinitely.`
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log('[SearchSync] MongoDB connection confirmed ready.');
};

const searchSyncWorker = new Worker(
  'search-sync',
  async (job) => {
    // Every job type in this worker touches MongoDB — guard once at the top
    // rather than repeating the check in each branch below.
    await waitForMongoConnection();

    const index = client.index(PRODUCTS_INDEX);

    // ── Index or update a single product ──────────────────────────────────
    if (job.name === JOBS.INDEX_PRODUCT) {
      const { productId } = job.data;

      const product = await Product.findById(productId)
        .populate('category', 'name')
        .populate('shop', 'name address verificationStatus');

      if (!product) {
        await index.deleteDocument(productId);
        console.log(`[SearchSync] Removed missing product ${productId} from index`);
        return;
      }

      const doc = await toSearchDocument(product);
      await index.addDocuments([doc]);
      console.log(`[SearchSync] Indexed product ${productId}`);
    }

    // ── Remove a deleted product ───────────────────────────────────────────
    if (job.name === JOBS.DELETE_PRODUCT) {
      const { productId } = job.data;
      await index.deleteDocument(productId);
      console.log(`[SearchSync] Deleted product ${productId} from index`);
    }

    // ── Full reindex — nightly safety net ──────────────────────────────────
    if (job.name === JOBS.FULL_REINDEX) {
      console.log('[SearchSync] Starting full reindex...');

      const BATCH_SIZE = 500;
      let processed = 0;
      let skip = 0;

      await index.deleteAllDocuments();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await Product.find({})
          .populate('category', 'name')
          .populate('shop', 'name address verificationStatus')
          .skip(skip)
          .limit(BATCH_SIZE)
          .lean();

        if (batch.length === 0) break;

        const docs = await toSearchDocuments(batch);
        await index.addDocuments(docs);

        processed += batch.length;
        skip += BATCH_SIZE;
        console.log(`[SearchSync] Reindexed ${processed} products so far...`);
      }

      console.log(`[SearchSync] Full reindex complete — ${processed} products indexed`);
    }
  },
  {
    connection: bullMQConnection,
    concurrency: 5,
  }
);

searchSyncWorker.on('failed', (job, err) => {
  console.error(`[SearchSync Worker] Job ${job?.id} failed:`, err.message);
});

module.exports = { searchSyncWorker };