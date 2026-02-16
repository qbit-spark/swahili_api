const Order = require('../models/Order');
const Product = require('../models/Product');
const { User } = require('../models/User');
const Shop = require('../models/Shop')
const mongoose = require('mongoose');
const { isValidObjectId } = mongoose;
const paymentService = require('../services/paymentService');
const notificationService = require('../services/notificationService');

const ORDER_STATUS_FLOW = {
  pending_payment: ['pending', 'cancelled'],
  pending: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [], // Final state
  cancelled: [] // Final state
};

const isValidStatusTransition = (currentStatus, newStatus) => {
  const allowedTransitions = ORDER_STATUS_FLOW[currentStatus] || [];
  return allowedTransitions.includes(newStatus);
};

exports.createOrder = async (req, res) => {
  try {
    const { productId, quantity, shippingAddress, paymentMethod } = req.body;
    const userId = req.user._id;

    // Validate input
    if (!productId || !quantity || !shippingAddress || !paymentMethod) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Missing required fields']
      });
    }

    // ✅ FIXED: Populate shop with owner field
    const product = await Product.findById(productId)
      .populate({
        path: 'shop',
        select: 'name email owner'
      })
      .populate('category', 'name');

    if (!product) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Product not found']
      });
    }

    // Check stock availability
    if (product.stock < quantity) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: [`Only ${product.stock} items available in stock`]
      });
    }

    // Calculate total amount
    const subtotal = product.price * quantity;
    const totalAmount = subtotal;

    // Prepare order data
    const orderData = {
      user: userId,
      shop: product.shop._id,
      items: [{
        product: productId,
        quantity,
        price: product.price,
        name: product.name
      }],
      shippingAddress,
      paymentMethod,
      amounts: {
        subtotal,
        total: totalAmount
      },
      status: paymentMethod === 'mobile_money' ? 'pending_payment' : 'pending',
      paymentStatus: 'pending'
    };

    // Process payment first if mobile money is selected
    if (paymentMethod === 'mobile_money') {
      const user = await User.findById(userId);
      const paymentResult = await paymentService.processPayment({
        amounts: orderData.amounts,
        user: {
          name: user.username,
          email: user.email
        },
        shippingAddress
      });

      // console.log("paymentResults:", paymentResult);

      if (!paymentResult.success) {
        return res.status(400).json({
          success: false,
          data: null,
          errors: ['Payment processing failed']
        });
      }

      // Add payment details to order data
      orderData.paymentDetails = {
        transactionId: paymentResult.message.order_id,
        provider: 'zenopay',
        status: 'pending',
        message: paymentResult.message.message,
        initiatedAt: new Date()
      };
    }

    // Create and save order
    const order = new Order(orderData);
    await order.save();

    // Update product stock and add order reference
    await Product.findByIdAndUpdate(
      productId,
      {
        $inc: { stock: -quantity },
        $push: { orders: order._id }
      }
    );

    // Update user's orders
    await User.findByIdAndUpdate(
      userId,
      { $push: { orders: order._id } }
    );

    // Create notifications for both shop owner and buyer
    const orderNotifications = {
      shop: {
        message: `New order #${order.orderNumber} for ${product.name}`,
        userId: product.shop.owner
      },
      buyer: {
        message: `Order #${order.orderNumber} placed successfully! We'll notify you about updates.`,
        userId: userId
      }
    };

    // ✅ FIXED: Fetch the correct users
    const [shopOwner, buyer] = await Promise.all([
      User.findById(product.shop.owner).select('username email expoPushToken'),
      User.findById(userId).select('username email expoPushToken')
    ]);

    // Create persistent notifications for both users
    await Promise.all([
      notificationService.createPersistentNotification(
        orderNotifications.shop.userId,
        orderNotifications.shop.message,
        order._id
      ),
      notificationService.createPersistentNotification(
        orderNotifications.buyer.userId,
        orderNotifications.buyer.message,
        order._id
      )
    ]);

    // Send push notifications if users have expo tokens
    const pushNotifications = [];

    if (shopOwner?.expoPushToken) {
      // console.log('📱 Sending push to shop owner:', shopOwner.username);
      pushNotifications.push(
        notificationService.sendPushNotification(
          shopOwner.expoPushToken,
          orderNotifications.shop.message,
          product.images[0]
        )
      );
    }

    if (buyer?.expoPushToken) {
      // console.log('📱 Sending push to buyer:', buyer.username);
      pushNotifications.push(
        notificationService.sendPushNotification(
          buyer.expoPushToken,
          orderNotifications.buyer.message,
          product.images[0]
        )
      );
    }

    // Send push notifications concurrently if any exist
    if (pushNotifications.length > 0) {
      await Promise.all(pushNotifications);
    }

    // Fetch the complete order with populated fields for response
    const populatedOrder = await Order.findById(order._id)
      .populate('shop', 'name')
      .populate('items.product', 'name image price');

    res.status(201).json({
      success: true,
      data: {
        order: {
          _id: populatedOrder._id,
          orderNumber: populatedOrder.orderNumber,
          status: populatedOrder.status,
          paymentStatus: populatedOrder.paymentStatus,
          paymentDetails: populatedOrder.paymentDetails,
          amounts: populatedOrder.amounts,
          items: populatedOrder.items.map(item => ({
            product: {
              _id: item.product._id,
              name: item.product.name,
              image: item.product.image
            },
            quantity: item.quantity,
            price: item.price
          })),
          shippingAddress: populatedOrder.shippingAddress,
          paymentMethod: populatedOrder.paymentMethod,
          createdAt: populatedOrder.createdAt
        }
      },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Invalid order ID format']
      });
    }

    const order = await Order.findById(id)
      .populate('user', 'name email')
      .populate({
        path: 'shop',
        select: 'name email owner'
      })
      .populate('items.product', 'name image price');

    if (!order) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Order not found']
      });
    }

    const isBuyer = order.user._id.toString() === req.user._id.toString();
    const isShopOwner = order.shop?.owner?.toString() === req.user._id.toString();

    if (!isBuyer && !isShopOwner) {
      return res.status(403).json({
        success: false,
        data: null,
        errors: ['Not authorized to view this order']
      });
    }

    res.json({
      success: true,
      data: { order },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.getUserOrders = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const status = req.query.status;

    let query = { user: req.user._id };
    if (status) {
      query.status = status;
    }

    const orders = await Order.find(query)
      .populate('shop', 'name')
      .populate('items.product', 'name image price')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Order.countDocuments(query);

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          totalRecords: total
        }
      },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    // Validate status value
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Invalid status value']
      });
    }

    const order = await Order.findById(orderId)
      .populate('shop', 'name owner')
      .populate('items.product', 'name image price')
      .populate('user', 'username email');

    if (!order) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Order not found']
      });
    }

    // console.log('🔍 Order shop owner:', order.shop.owner);
    // console.log('🔍 Current user:', req.user._id);

    // Check authorization (only shop owner or admin can update status)
    const isShopOwner = order.shop.owner.equals(req.user._id);
    const isAdmin = req.user.userType === 'ADMIN';

    if (!isShopOwner && !isAdmin) {
      console.error('❌ Not authorized - shop owner:', order.shop.owner, 'user:', req.user._id);
      return res.status(403).json({
        success: false,
        data: null,
        errors: ['Not authorized to update this order']
      });
    }

    // console.log('✅ Authorization check passed');

    // Validate status transition
    if (!isValidStatusTransition(order.status, status)) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: [`Cannot change status from ${order.status} to ${status}`]
      });
    }

    // Update status and add status history
    const statusUpdate = {
      status,
      updatedAt: Date.now(),
      statusHistory: [
        ...order.statusHistory || [],
        {
          status: order.status,
          timestamp: new Date(),
          updatedBy: req.user._id
        }
      ]
    };

    // Special handling for specific status transitions
    if (status === 'cancelled') {
      // If order is cancelled, restore product stock
      await Promise.all(order.items.map(async (item) => {
        await Product.findByIdAndUpdate(
          item.product._id,
          { $inc: { stock: item.quantity } }
        );
      }));

      // console.log('📦 Stock restored for cancelled order');
    } else if (status === 'delivered' && order.status !== 'delivered') {
      // Credit shop wallet when order is delivered
      const shop = await Shop.findById(order.shop._id);
      if (shop) {
        if (!shop.wallet) {
          shop.wallet = { currentBalance: 0, lockedBalance: 0 };
        }
        const orderRevenue = order.amounts.subtotal || order.amounts.total;
        shop.wallet.currentBalance += orderRevenue;
        shop.metrics.totalRevenue = (shop.metrics.totalRevenue || 0) + orderRevenue;
        await shop.save();

        // console.log(`💰 Credited ${orderRevenue} to shop wallet`);
      }
    }

    // Update the order
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      statusUpdate,
      { new: true }
    ).populate('shop', 'name')
      .populate('items.product', 'name image price')
      .populate('statusHistory.updatedBy', 'username');

    // Send notification to customer about status change
    const statusMessages = {
      processing: `Your order #${order.orderNumber} is being processed`,
      shipped: `Your order #${order.orderNumber} has been shipped!`,
      delivered: `Your order #${order.orderNumber} has been delivered`,
      cancelled: `Your order #${order.orderNumber} has been cancelled`
    };

    if (statusMessages[status]) {
      await notificationService.createPersistentNotification(
        order.user._id,
        statusMessages[status],
        order._id
      );

      // Send push notification if user has token
      const buyer = await User.findById(order.user._id);
      if (buyer?.expoPushToken) {
        await notificationService.sendPushNotification(
          buyer.expoPushToken,
          statusMessages[status]
        );
      }
    }

    console.log(`✅ Order ${order.orderNumber} status updated: ${order.status} → ${status}`);

    res.json({
      success: true,
      data: { order: updatedOrder },
      errors: []
    });

  } catch (err) {
    console.error('❌ Error updating order status:', err);
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.checkPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;

    // Validate if orderId is a valid MongoDB ObjectId
    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Invalid order ID format']
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Order not found']
      });
    }

    // Check if user is authorized to view this order
    if (order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        data: null,
        errors: ['Not authorized to view this order']
      });
    }

    const paymentStatus = await paymentService.checkPaymentStatus(order.paymentDetails.transactionId);

    res.json({
      success: true,
      data: {
        paymentStatus: paymentStatus,
        transactionId: order.paymentDetails.transactionId,
        paymentDetails: order.paymentDetails
      },
      errors: []
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [error.message]
    });
  }
};

exports.getOrderStatuses = async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        statuses: {
          pending: {
            description: 'Order has been placed but not yet processed',
            nextPossibleStatuses: ORDER_STATUS_FLOW.pending
          },
          processing: {
            description: 'Order is being processed and prepared for shipping',
            nextPossibleStatuses: ORDER_STATUS_FLOW.processing
          },
          shipped: {
            description: 'Order has been shipped and is in transit',
            nextPossibleStatuses: ORDER_STATUS_FLOW.shipped
          },
          delivered: {
            description: 'Order has been delivered to the customer',
            nextPossibleStatuses: ORDER_STATUS_FLOW.delivered
          },
          cancelled: {
            description: 'Order has been cancelled',
            nextPossibleStatuses: ORDER_STATUS_FLOW.cancelled
          }
        }
      },
      errors: []
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.updatePaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { paymentStatus, transactionId, paymentDetails } = req.body;

    // Validate if orderId is a valid MongoDB ObjectId
    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Invalid order ID format']
      });
    }

    // Find the order
    const order = await Order.findById(orderId)
      .populate('shop', 'name email')
      .populate('user', 'name email');

    if (!order) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Order not found']
      });
    }

    // Update payment details
    const updateData = {
      'paymentDetails.status': paymentStatus,
      'paymentDetails.updatedAt': new Date(),
      'paymentDetails.transactionId': transactionId || order.paymentDetails.transactionId,
      ...paymentDetails && { 'paymentDetails.details': paymentDetails }
    };

    // If payment is successful, update order status to pending
    if (paymentStatus === 'completed') {
      updateData.status = 'pending';
    } else if (paymentStatus === 'failed') {
      updateData.status = 'cancelled';
    }

    // Update the order
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: updateData },
      { new: true }
    ).populate('shop', 'name')
      .populate('items.product', 'name image price');

    // Send notification based on payment status
    const notificationMessage = paymentStatus === 'completed'
      ? `Payment successful for order #${order.orderNumber}`
      : `Payment ${paymentStatus} for order #${order.orderNumber}`;

    // Notify customer
    await notificationService.createPersistentNotification(
      order.user._id,
      notificationMessage,
      order._id
    );

    res.json({
      success: true,
      data: { order: updatedOrder },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.getShopOrders = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const status = req.query.status;
    const paymentStatus = req.query.paymentStatus;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    // Build query
    let query = { shop: req.user._id };

    // Add filters if provided
    if (status) {
      query.status = status;
    }
    if (paymentStatus) {
      query['paymentDetails.status'] = paymentStatus;
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }

    // Get orders
    const orders = await Order.find(query)
      .populate('user', 'name email')
      .populate('items.product', 'name image price')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Get total count for pagination
    const total = await Order.countDocuments(query);

    // Calculate some basic statistics
    const stats = await Order.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$amounts.total' },
          averageOrderValue: { $avg: '$amounts.total' }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          totalRecords: total
        },
        stats: stats[0] || {
          totalOrders: 0,
          totalRevenue: 0,
          averageOrderValue: 0
        }
      },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.getMyShop = async (req, res) => {
  try {
    const userId = req.user._id;
    const { startDate, endDate } = req.query;

    // Get shop details
    const shop = await Shop.findOne({ owner: userId })
      .select('name description image rating');

    if (!shop) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Shop not found']
      });
    }

    // Build date range query
    let dateQuery = {};
    if (startDate || endDate) {
      dateQuery.createdAt = {};
      if (startDate) {
        dateQuery.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        dateQuery.createdAt.$lte = new Date(endDate);
      }
    }

    // Get order statistics
    const orderStats = await Order.aggregate([
      {
        $match: {
          shop: shop._id,
          ...dateQuery
        }
      },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$amounts.total' },
          averageOrderValue: { $avg: '$amounts.total' },
          ordersByStatus: {
            $push: '$status'
          }
        }
      }
    ]);

    // Calculate status counts
    const statusCounts = orderStats[0]?.ordersByStatus.reduce((acc, status) => {
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}) || {};

    // Get recent orders
    const recentOrders = await Order.find({ shop: shop._id })
      .sort({ createdAt: -1 })
      // .limit(5)
      .populate('user', 'name')
      .populate('items.product', 'name image price');

    res.json({
      success: true,
      data: {
        shop: {
          _id: shop._id,
          name: shop.name,
          description: shop.description,
          image: shop.image,
          rating: shop.rating,
          totalOrders: orderStats[0]?.totalOrders || 0,
          statistics: {
            totalRevenue: orderStats[0]?.totalRevenue || 0,
            averageOrderValue: orderStats[0]?.averageOrderValue || 0,
            ordersByStatus: {
              pending: statusCounts.pending || 0,
              processing: statusCounts.processing || 0,
              shipped: statusCounts.shipped || 0,
              delivered: statusCounts.delivered || 0,
              cancelled: statusCounts.cancelled || 0
            }
          },
          recentOrders: recentOrders.map(order => ({
            _id: order._id,
            orderNumber: order.orderNumber,
            customer: order.user.name,
            amount: order.amounts.total,
            status: order.status,
            createdAt: order.createdAt
          }))
        }
      },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};
