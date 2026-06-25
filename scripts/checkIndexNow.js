/**
 * scripts/checkIndexNow.js
 * ──────────────────────────
 * Run: node scripts/checkIndexNow.js
 *
 * No MongoDB, no workers, no transforms. Pure question to Meilisearch:
 * "what do you actually have in the products index right this second."
 * Removes every layer of ambiguity from previous diagnostics.
 */

require('dotenv').config();

async function main() {
  const { client, PRODUCTS_INDEX } = require('../src/config/meilisearch');

  console.log(`Checking index: "${PRODUCTS_INDEX}"`);
  console.log(`Connecting to: ${process.env.MEILISEARCH_HOST}`);

  // 1. Raw stats — the actual document count right now
  const index = client.index(PRODUCTS_INDEX);
  const stats = await index.getStats();
  console.log('\n--- Index stats ---');
  console.log(`numberOfDocuments: ${stats.numberOfDocuments}`);

  // 2. List ALL indexes this client/key can see — catches the case where
  // there are multiple indexes (e.g. "products" vs "Products" vs a typo'd
  // name) and the app is writing to one while reading from another.
  console.log('\n--- All indexes visible to this API key ---');
  const allIndexes = await client.getIndexes();
  allIndexes.results.forEach((idx) => {
    console.log(`  - "${idx.uid}" (primaryKey: ${idx.primaryKey}, created: ${idx.createdAt})`);
  });

  // 3. Pull the first 5 raw documents directly — no search query involved,
  // just "give me whatever you have"
  console.log('\n--- First 5 raw documents (no query, just listing) ---');
  const docs = await index.getDocuments({ limit: 5 });
  console.log(`Total returned: ${docs.results.length}`);
  docs.results.forEach((d, i) => {
    console.log(`  [${i}] id=${d.id} name="${d.name?.slice(0, 50)}"`);
  });

  // 4. Try the exact same search the API route would run, but log
  // EVERYTHING about the raw response
  console.log('\n--- Raw search("iphone") response ---');
  const searchResult = await index.search('iphone');
  console.log(JSON.stringify(searchResult, null, 2));

  console.log('\n--- Raw search("") with no query at all (browse mode) ---');
  const browseResult = await index.search('', { limit: 5 });
  console.log(`estimatedTotalHits: ${browseResult.estimatedTotalHits}`);
  console.log(`hits returned: ${browseResult.hits.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});