const { Queue } = require('bullmq');
const { bullMQConnection } = require('../config/redis');

const searchSyncQueue = new Queue('search-sync', {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

const JOBS = {
  INDEX_PRODUCT:  'index:product',
  DELETE_PRODUCT: 'delete:product',
  FULL_REINDEX:   'reindex:full',
};

/** Index or re-index a single product — called after create/update */
const syncProductToIndex = (productId) =>
  searchSyncQueue.add(JOBS.INDEX_PRODUCT, { productId }, {
    jobId: `index-product--${productId}`, // colon-free — see JOBID_FIX
    priority: 5,
  });

/** Remove a product from the search index — called after delete */
const removeProductFromIndex = (productId) =>
  searchSyncQueue.add(JOBS.DELETE_PRODUCT, { productId }, {
    jobId: `delete-product--${productId}`,
    priority: 5,
  });

/** Full catalogue reindex — nightly safety net + manual trigger for drift recovery */
const triggerFullReindex = () =>
  searchSyncQueue.add(JOBS.FULL_REINDEX, {}, { jobId: 'full-reindex-run' });

module.exports = {
  searchSyncQueue,
  JOBS,
  syncProductToIndex,
  removeProductFromIndex,
  triggerFullReindex,
};