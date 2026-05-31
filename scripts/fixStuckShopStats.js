require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../src/models/Order');
const Shop = require('../src/models/Shop');

const BATCH_SIZE = 50;

async function recalculateShopMetrics(shop) {
  const deliveredOrders = await Order.find({
    shop: shop._id,
    status: 'delivered'
  })
    .select('amounts.total orderNumber status')
    .lean();

  const totalOrders = deliveredOrders.length;

  const totalRevenue = deliveredOrders.reduce(
    (sum, order) => sum + (order.amounts?.total || 0),
    0
  );

  await Shop.updateOne(
    { _id: shop._id },
    {
      $set: {
        'metrics.totalOrders': totalOrders,
        'metrics.totalRevenue': totalRevenue
      }
    }
  );

  return { totalOrders, totalRevenue };
}

async function run() {
  try {
    console.log('\n====================================');
    console.log('🚀 SHOP METRICS REBUILD STARTING');
    console.log('====================================\n');

    await mongoose.connect(process.env.MONGODB_URI);

    console.log('📡 Connected to database\n');

    const totalShops = await Shop.countDocuments();
    console.log(`🏪 Total shops found: ${totalShops}\n`);

    let processed = 0;
    let updated = 0;
    let errors = 0;

    const cursor = Shop.find().cursor();

    for await (const shop of cursor) {
      try {
        processed++;

        console.log('------------------------------------');
        console.log(`🏪 [${processed}/${totalShops}] ${shop.name}`);
        console.log(`🆔 Shop ID: ${shop._id}`);

        const stats = await recalculateShopMetrics(shop);

        console.log(`📦 Orders: ${stats.totalOrders}`);
        console.log(`💰 Revenue: ${stats.totalRevenue}`);

        updated++;

      } catch (err) {
        errors++;
        console.error(`❌ Error processing shop ${shop._id}`);
        console.error(err.message);
      }
    }

    console.log('\n====================================');
    console.log('🎉 REBUILD COMPLETE');
    console.log('====================================');
    console.log(`✔ Processed: ${processed}`);
    console.log(`✔ Updated: ${updated}`);
    console.log(`❌ Errors: ${errors}`);
    console.log('====================================\n');

    await mongoose.disconnect();

  } catch (err) {
    console.error('💥 FATAL ERROR:', err);
    process.exit(1);
  }
}

run();