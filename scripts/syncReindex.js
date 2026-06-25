/**
 * scripts/syncReindex.js
 * ────────────────────────
 * Run: node scripts/syncReindex.js
 *
 * Does the ENTIRE reindex synchronously in this one process — no BullMQ,
 * no separate worker, no queue, no timing ambiguity. Connects to MongoDB,
 * fetches every product, transforms, pushes to Meilisearch, and WAITS for
 * each batch's task to actually succeed before moving to the next one.
 *
 * This removes every possible race condition from the previous approach
 * (worker process timing, job pickup timing, connection readiness timing)
 * by doing it all in a single linear sequence with no async handoffs to
 * a different process.
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  console.log('--- Connecting to MongoDB ---');
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  while (mongoose.connection.readyState !== 1) {
    console.log(`  waiting... readyState=${mongoose.connection.readyState}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('✅ MongoDB connection confirmed ready (readyState=1)');

  require('../src/models/Category');
  require('../src/models/Shop');
  require('../src/models/SellerVerification');
  const Product = require('../src/models/Product');

  console.log('\n--- Connecting to Meilisearch ---');
  const { client, PRODUCTS_INDEX, waitForTask } = require('../src/config/meilisearch');
  const index = client.index(PRODUCTS_INDEX);

  const health = await client.health();
  console.log('✅ Meilisearch:', health);

  console.log('\n--- Clearing existing index documents ---');
  const deleteTask = await index.deleteAllDocuments();
  await waitForTask(deleteTask.taskUid);
  console.log('✅ Index cleared');

  console.log('\n--- Counting products in MongoDB ---');
  const totalInMongo = await Product.countDocuments({});
  console.log(`✅ MongoDB has ${totalInMongo} products`);

  if (totalInMongo === 0) {
    console.log('❌ Nothing to index — MongoDB itself is empty. Stopping.');
    process.exit(1);
  }

  console.log('\n--- Fetching and indexing in batches ---');
  const { toSearchDocuments } = require('../src/services/productSearchTransform');

  const BATCH_SIZE = 100;
  let processed = 0;
  let skip = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await Product.find({})
      .populate('category', 'name')
      .populate('shop', 'name address verificationStatus')
      .skip(skip)
      .limit(BATCH_SIZE)
      .lean();

    console.log(`  Fetched batch at skip=${skip}: ${batch.length} products`);

    if (batch.length === 0) {
      console.log('  Empty batch — reached end of collection.');
      break;
    }

    const docs = await toSearchDocuments(batch);
    console.log(`  Transformed ${docs.length} documents`);

    const addTask = await index.addDocuments(docs);
    console.log(`  Pushed, task ${addTask.taskUid}, waiting for it to complete...`);

    const finished = await waitForTask(addTask.taskUid);
    console.log(`  ✅ Task ${addTask.taskUid} ${finished.status} — indexed ${finished.details?.indexedDocuments ?? '?'} docs`);

    processed += batch.length;
    skip += BATCH_SIZE;
  }

  console.log(`\n--- Done. Processed ${processed} products from MongoDB. ---`);

  console.log('\n--- Final verification ---');
  const finalStats = await index.getStats();
  console.log(`✅ Index now reports numberOfDocuments: ${finalStats.numberOfDocuments}`);

  if (finalStats.numberOfDocuments !== totalInMongo) {
    console.log(`⚠️  MISMATCH: MongoDB has ${totalInMongo} but index has ${finalStats.numberOfDocuments}.`);
    console.log('   Check above for any task that did not say "succeeded".');
  } else {
    console.log('✅ Counts match exactly. Search should now return real results.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Script failed with error:');
  console.error(err);
  process.exit(1);
});