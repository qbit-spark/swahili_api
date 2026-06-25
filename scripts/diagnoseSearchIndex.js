/**
 * scripts/diagnoseSearchIndex.js
 * ────────────────────────────────
 * Standalone script — run directly with `node src/scripts/diagnoseSearchIndex.js`
 * (adjust path to match your actual project root). Does NOT go through BullMQ
 * or the worker at all — talks to MongoDB and Meilisearch directly, one step
 * at a time, logging clearly at each stage so we can see exactly where it
 * breaks instead of guessing from worker logs.
 *
 * This also clears any stuck 'full-reindex-run' job from the queue, in case
 * BullMQ's jobId deduplication was silently no-op'ing repeated trigger calls.
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  console.log('--- Step 1: Connect to MongoDB ---');
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('✅ MongoDB connected');

  // IMPORTANT: server.js registers every Mongoose model as a side effect of
  // requiring routes/controllers at boot. This script ran the Product model
  // in isolation, so Category/Shop were never registered with Mongoose,
  // causing the populate() to fail with MissingSchemaError. Explicitly
  // requiring the models we need fixes that without booting the entire
  // Express app. Wrapped in try/catch per-model in case any filename/path
  // differs slightly from what's assumed here — a missing optional model
  // shouldn't block the whole diagnostic from running.
  const requireModel = (relPath, label) => {
    try {
      require(relPath);
      console.log(`✅ Registered model: ${label}`);
    } catch (err) {
      console.log(`⚠️  Could not require ${label} from ${relPath} — ${err.message}`);
      console.log(`   If this model is needed for populate(), adjust the path at the top of this script.`);
    }
  };

  requireModel('../src/models/Category', 'Category');
  requireModel('../src/models/Shop', 'Shop');
  requireModel('../src/models/SellerVerification', 'SellerVerification');
  const Product = require('../src/models/Product');
  console.log('✅ Product model loaded');

  console.log('\n--- Step 2: Count products directly ---');
  const totalCount = await Product.countDocuments({});
  console.log(`✅ Product.countDocuments({}) = ${totalCount}`);

  if (totalCount === 0) {
    console.log('❌ STOP: MongoDB itself has zero products in this database/collection.');
    console.log('   Check MONGODB_URI / MONGO_URI points to the same DB you see in your admin panel.');
    process.exit(1);
  }

  console.log('\n--- Step 3: Fetch one product with populate ---');
  const sample = await Product.find({})
    .populate('category', 'name')
    .populate('shop', 'name address verificationStatus')
    .limit(1)
    .lean();

  if (!sample.length) {
    console.log('❌ STOP: find() with populate returned nothing despite countDocuments > 0.');
    console.log('   This would indicate a query/connection issue, not a data issue.');
    process.exit(1);
  }
  console.log('✅ Sample product fetched:', JSON.stringify(sample[0], null, 2).slice(0, 500));

  console.log('\n--- Step 4: Transform to search document ---');
  const { toSearchDocuments } = require('../src/services/productSearchTransform');
  let docs;
  try {
    docs = await toSearchDocuments(sample);
    console.log('✅ Transform succeeded:', JSON.stringify(docs[0], null, 2));
  } catch (err) {
    console.log('❌ STOP: toSearchDocuments threw an error:');
    console.error(err);
    process.exit(1);
  }

  console.log('\n--- Step 5: Connect to Meilisearch directly ---');
  const { client, PRODUCTS_INDEX } = require('../src/config/meilisearch');
  const index = client.index(PRODUCTS_INDEX);

  try {
    const health = await client.health();
    console.log('✅ Meilisearch health:', health);
  } catch (err) {
    console.log('❌ STOP: Cannot reach Meilisearch from Node. Check MEILISEARCH_HOST/API_KEY.');
    console.error(err.message);
    process.exit(1);
  }

  console.log('\n--- Step 6: Push the sample document directly ---');
  let enqueuedTask;
  try {
    enqueuedTask = await index.addDocuments(docs);
    console.log('✅ addDocuments() accepted, task:', enqueuedTask);
  } catch (err) {
    console.log('❌ STOP: addDocuments() threw an error:');
    console.error(err);
    process.exit(1);
  }

  console.log('\n--- Step 6b: Poll the task itself until it finishes (up to 10s) ---');
  // Different SDK versions expose task lookup differently — try the known
  // shapes rather than assuming one. Whichever works gets used.
  const getTaskStatus = async (taskUid) => {
    if (client.tasks?.getTask) return client.tasks.getTask(taskUid);
    if (client.getTask)        return client.getTask(taskUid);
    if (index.getTask)         return index.getTask(taskUid);
    throw new Error('Could not find a getTask method on this Meilisearch SDK version — check installed `meilisearch` package version and its docs for task lookup.');
  };

  let finalTaskStatus = null;
  try {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const taskInfo = await getTaskStatus(enqueuedTask.taskUid);
      console.log(`   [${i + 1}s] task status: ${taskInfo.status}`);
      if (taskInfo.status === 'succeeded' || taskInfo.status === 'failed') {
        finalTaskStatus = taskInfo;
        break;
      }
    }
  } catch (err) {
    console.log('⚠️  Could not poll task status:', err.message);
    console.log('   Skipping to index stats check instead.');
  }

  if (finalTaskStatus?.status === 'failed') {
    console.log('❌ TASK FAILED. Meilisearch error details:');
    console.log(JSON.stringify(finalTaskStatus.error, null, 2));
  } else if (finalTaskStatus?.status === 'succeeded') {
    console.log('✅ Task succeeded:', JSON.stringify(finalTaskStatus, null, 2));
  } else if (finalTaskStatus === null) {
    console.log('⚠️  Task never confirmed succeeded/failed within 10s, or polling was skipped.');
  }

  console.log('\n--- Step 7: Check index stats ---');
  await new Promise((r) => setTimeout(r, 500));
  const stats = await index.getStats();
  console.log('✅ Index stats:', stats);

  if (stats.numberOfDocuments === 0) {
    console.log('❌ The document was accepted but never landed. Check Meilisearch logs for a task failure.');
  } else {
    console.log(`✅ SUCCESS — ${stats.numberOfDocuments} document(s) now in the index.`);
  }

  console.log('\n--- Step 8: Check for a stuck full-reindex-run job in BullMQ ---');
  const { searchSyncQueue } = require('../src/queues/searchSyncQueue');
  const waiting = await searchSyncQueue.getJob('full-reindex-run');
  if (waiting) {
    const state = await waiting.getState();
    console.log(`⚠️  Found existing job 'full-reindex-run' in state: ${state}`);
    console.log('   Removing it so the next trigger creates a fresh job...');
    await waiting.remove();
    console.log('✅ Removed stuck job.');
  } else {
    console.log('✅ No stuck job found under that ID.');
  }

  console.log('\n--- Done. Re-run your normal full reindex trigger now. ---');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error in diagnostic script:', err);
  process.exit(1);
});