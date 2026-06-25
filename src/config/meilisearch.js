const { Meilisearch } = require('meilisearch'); 

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Meilisearch({
  host:   process.env.MEILISEARCH_HOST || 'http://127.0.0.1:7700',
  apiKey: process.env.MEILISEARCH_API_KEY,
});

const PRODUCTS_INDEX = 'products';

// ─── Index configuration ──────────────────────────────────────────────────────
//
// ROOT CAUSE OF "primary_key_multiple_candidates_found":
// Meilisearch infers the primary key from the FIRST document ever pushed to
// an index, ONLY if the index doesn't already have one set. Our documents
// have both `id` and `shopId` ending in "id", so Meilisearch refused to
// guess between them and failed the entire write — which is why documents
// were accepted (enqueued) but never actually landed (0 in the index).
//
// Fix: explicitly create the index with primaryKey: 'id' BEFORE any
// documents are ever pushed. This removes the ambiguity entirely — once
// a primary key is set on an index, Meilisearch never tries to infer one
// again for that index, regardless of what other "id"-like fields exist
// in future documents.
const configureProductsIndex = async () => {
  let indexExists = true;
  try {
    await client.getIndex(PRODUCTS_INDEX);
  } catch (err) {
    indexExists = false;
  }

  if (!indexExists) {
    console.log(`[Meilisearch] Creating index '${PRODUCTS_INDEX}' with explicit primaryKey: 'id'...`);
    const createTask = await client.createIndex(PRODUCTS_INDEX, { primaryKey: 'id' });
    await waitForTask(createTask.taskUid);
    console.log(`[Meilisearch] Index created.`);
  }

  const index = client.index(PRODUCTS_INDEX);

  await waitForTask((await index.updateSearchableAttributes([
    'name',
    'description',
    'categoryName',
    'shopName',
    'tags',
  ])).taskUid);

  await waitForTask((await index.updateFilterableAttributes([
    'category',
    'categoryName',
    'shopId',
    'city',
    'condition',
    'price',
    'inStock',
    'isVerifiedSeller',
    'sellerTier',
    'avgRating',
  ])).taskUid);

  await waitForTask((await index.updateSortableAttributes([
    'price',
    'createdAt',
    'views',
    'avgRating',
    '_exploreScore',
  ])).taskUid);

  await waitForTask((await index.updateRankingRules([
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness',
    'sellerTier:desc',
  ])).taskUid);

  await waitForTask((await index.updateTypoTolerance({
    enabled: true,
    minWordSizeForTypos: {
      oneTypo: 4,
      twoTypos: 8,
    },
    disableOnAttributes: [],
  })).taskUid);

  await waitForTask((await index.updateSynonyms({
    phone:    ['mobile', 'smartphone', 'cellphone'],
    mobile:   ['phone', 'smartphone'],
    laptop:   ['notebook', 'computer'],
    tv:       ['television'],
    fridge:   ['refrigerator'],
    sneakers: ['trainers', 'shoes'],
  })).taskUid);

  console.log('[Meilisearch] Products index configured');
};

/**
 * Polls a task until it reaches succeeded/failed, throws on failure with
 * Meilisearch's own error message surfaced (instead of swallowing it the
 * way the previous `.waitTask?.() ?? Promise.resolve()` pattern did, which
 * is exactly what let this primary-key bug pass silently before).
 *
 * Tries multiple SDK method shapes since the task-lookup API has moved
 * around across meilisearch package versions.
 */
const waitForTask = async (taskUid, timeoutMs = 10000) => {
  const getTask = async () => {
    if (client.tasks?.getTask) return client.tasks.getTask(taskUid);
    if (client.getTask)        return client.getTask(taskUid);
    throw new Error('No compatible getTask method found on this meilisearch SDK version.');
  };

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await getTask();
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed') {
      throw new Error(
        `Meilisearch task ${taskUid} failed: ${task.error?.message ?? JSON.stringify(task.error)}`
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Meilisearch task ${taskUid} did not complete within ${timeoutMs}ms`);
};

module.exports = { client, PRODUCTS_INDEX, configureProductsIndex, waitForTask };