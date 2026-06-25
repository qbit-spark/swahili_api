/**
 * scripts/fixSearchIndex.js
 * ───────────────────────────
 * Run ONCE: `node src/scripts/fixSearchIndex.js`
 *
 * Your 'products' index in Meilisearch currently has NO primary key set,
 * because the original configureProductsIndex() only called client.index()
 * (which just returns a handle, it doesn't create anything) and never
 * called client.createIndex() with an explicit primaryKey. Every document
 * push since then has been silently failing with
 * "primary_key_multiple_candidates_found".
 *
 * This script:
 *   1. Deletes the existing broken index entirely (it has 0 documents
 *      anyway, so there's nothing to lose)
 *   2. Recreates it with primaryKey: 'id' explicitly set
 *   3. Re-applies all searchable/filterable/sortable settings
 *   4. Triggers a full reindex from MongoDB
 *
 * After this, configureProductsIndex() in config/meilisearch.js (the
 * corrected version) will keep working correctly on every future boot,
 * since it now checks for the index's existence and creates it with the
 * right primary key the first time, and just re-applies settings on
 * every subsequent boot without ever needing to recreate it.
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('✅ MongoDB connected');

  const { client, PRODUCTS_INDEX, configureProductsIndex, waitForTask } = require('../src/config/meilisearch');

  console.log(`\n--- Deleting existing '${PRODUCTS_INDEX}' index (if it exists) ---`);
  try {
    const deleteTask = await client.deleteIndex(PRODUCTS_INDEX);
    await waitForTask(deleteTask.taskUid);
    console.log('✅ Old index deleted');
  } catch (err) {
    console.log(`ℹ️  Nothing to delete or already gone: ${err.message}`);
  }

  console.log('\n--- Recreating index with correct settings ---');
  await configureProductsIndex();
  console.log('✅ Index recreated with primaryKey: "id" and all settings applied');

  console.log('\n--- Triggering full reindex from MongoDB ---');
  const { triggerFullReindex } = require('../src/queues/searchSyncQueue');
  await triggerFullReindex();
  console.log('✅ Reindex job queued — check your worker logs for:');
  console.log('   "[SearchSync] Full reindex complete — N products indexed"');
  console.log('\nGive it a few seconds, then verify with the diagnostic script again');
  console.log('or hit GET /api/v1/search/suggest?q=fashion to confirm results return.');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fix script failed:', err);
  process.exit(1);
});