const Order = require('../../src/models/Order');
const Shop = require('../../src/models/Shop');

async function recalculateShopMetrics(shopId) {
  const deliveredOrders = await Order.find({
    shop: shopId,
    status: 'delivered'
  });

  const totalOrders = deliveredOrders.length;

  const totalRevenue = deliveredOrders.reduce(
    (sum, order) => sum + (order.amounts?.total || 0),
    0
  );

  await Shop.findByIdAndUpdate(shopId, {
    $set: {
      'metrics.totalOrders': totalOrders,
      'metrics.totalRevenue': totalRevenue
    }
  });

  console.log({
    totalOrders,
    totalRevenue
  });
}