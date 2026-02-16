const Order = require('../models/Order');
const notificationService = require('../services/notificationService');
const { User } = require('../models/User');
const crypto = require('crypto');
const PaymentService = require('../services/paymentService');

/**
 * Handle ZenoPay payment webhook callbacks
 * This endpoint receives payment status updates from ZenoPay SDK
 */
exports.handleZenopayCallback = async (req, res) => {
    try {
        // console.log('🔔 WEBHOOK RECEIVED');
        // console.log('📋 HEADERS:', JSON.stringify(req.headers, null, 2));
        // console.log('📋 RAW HEADERS:', req.rawHeaders);
        // console.log('📦 BODY:', JSON.stringify(req.body, null, 2));

        const apiKey = req.headers['x-api-key'];

        // Check if API key is present
        if (apiKey) {
            // Great! ZenoPay finally sent it
            if (apiKey !== process.env.ZENOPAY_API_KEY) {
                console.error('🚫 Invalid API key');
                return res.status(401).json({ error: 'Unauthorized' });
            }
            // console.log('✅ API key verified');
        } else {
            // No API key - fall back to API verification
            console.warn('⚠️ No x-api-key header received (SDK issue?)');
            console.warn('⚠️ Will verify with ZenoPay API instead');
        }

        const { order_id, payment_status, reference } = req.body;

        if (!order_id) {
            return res.status(400).json({ message: 'Missing order_id' });
        }

        // ✅ FIXED: Properly populate shop owner
        const order = await Order.findOne({
            'paymentDetails.transactionId': order_id
        })
        .populate('user', 'username email expoPushToken')
        .populate({
            path: 'shop',
            populate: {
                path: 'owner',
                select: 'username email expoPushToken'
            }
        });

        if (!order) {
            return res.status(200).json({
                status: 'received',
                message: 'Order not found'
            });
        }

        // ✅ ALWAYS verify with API (regardless of header presence)
        // console.log('🔍 Verifying with ZenoPay API...');
        const verifyResult = await PaymentService.checkPaymentStatus(order_id);
        const actualStatus = verifyResult.message?.payment_status;

        if (actualStatus !== 'COMPLETED') {
            console.warn(`⚠️ Payment not completed. Status: ${actualStatus}`);
            return res.status(200).json({
                status: 'received',
                message: 'Payment not completed'
            });
        }

        // Prevent duplicate processing
        if (order.paymentStatus === 'completed') {
            return res.status(200).json({
                status: 'received',
                message: 'Already processed'
            });
        }

        // console.log('✅ Payment verified - updating order');

        // Update order
        order.paymentStatus = 'completed';
        order.status = 'pending';
        order.paymentDetails.status = 'completed';
        order.paymentDetails.reference = reference;
        order.paymentDetails.completedAt = new Date();
        await order.save();

        // console.log(`✅ Order ${order.orderNumber} completed`);
        
        try {
            // ✅ FIXED: Get shop owner from shop.owner
            let buyer = order.user;
            let shopOwner = order.shop?.owner;

            // Re-fetch if not fully populated
            if (!buyer?.username || !buyer?.expoPushToken) {
                buyer = await User.findById(order.user)
                    .select('username email expoPushToken');
            }
            
            if (!shopOwner?.username || !shopOwner?.expoPushToken) {
                // Get shop owner ID from the shop
                const shopOwnerId = order.shop?.owner?._id || order.shop?.owner;
                if (shopOwnerId) {
                    shopOwner = await User.findById(shopOwnerId)
                        .select('username email expoPushToken');
                }
            }

            const notifications = [];
            const notificationMessages = {
                buyer: `Payment confirmed for order #${order.orderNumber}! Your order is being processed.`,
                shop: `Payment received for order #${order.orderNumber}. Please prepare the items for shipping.`
            };

            if (buyer) {
                notifications.push(
                    notificationService.createPersistentNotification(
                        buyer._id,
                        notificationMessages.buyer,
                        order._id
                    )
                );

                if (buyer.expoPushToken) {
                    // console.log('📱 Sending push to buyer:', buyer.username);
                    notifications.push(
                        notificationService.sendPushNotification(
                            buyer.expoPushToken,
                            notificationMessages.buyer
                        )
                    );
                }
            }

            if (shopOwner) {
                notifications.push(
                    notificationService.createPersistentNotification(
                        shopOwner._id,
                        notificationMessages.shop,
                        order._id
                    )
                );

                if (shopOwner.expoPushToken) {
                    // console.log('📱 Sending push to shop owner:', shopOwner.username);
                    notifications.push(
                        notificationService.sendPushNotification(
                            shopOwner.expoPushToken,
                            notificationMessages.shop
                        )
                    );
                } else {
                    console.warn('⚠️ Shop owner has no expoPushToken');
                }
            } else {
                console.warn('⚠️ Shop owner not found');
            }

            await Promise.allSettled(notifications);
            // console.log('✅ Notifications sent');
        } catch (notifError) {
            console.error('Error sending notifications:', notifError);
        }

        res.status(200).json({ status: 'received' });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(200).json({ status: 'received', error: error.message });
    }
};

/**
 * Optional: Manual order status check endpoint
 * Use this to manually verify payment status with ZenoPay
 */
exports.checkPaymentStatus = async (req, res) => {
    try {
        const { orderId } = req.params;

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        if (!order.paymentDetails?.transactionId) {
            return res.status(400).json({
                success: false,
                message: 'No payment transaction found for this order'
            });
        }

        // Call ZenoPay API to check status
        const paymentService = require('../services/paymentService');
        const statusResult = await paymentService.checkPaymentStatus(
            order.paymentDetails.transactionId
        );

        // console.log('Payment status check result:', statusResult);

        // Update order if status has changed
        if (statusResult.success) {
            const paymentStatus = statusResult.message?.status?.toUpperCase();

            if (paymentStatus === 'COMPLETED' || paymentStatus === 'SUCCESS') {
                order.paymentStatus = 'completed';
                order.status = 'pending';
                order.paymentDetails.status = 'completed';
                order.paymentDetails.completedAt = new Date();
                await order.save();

                // console.log(`✅ Order ${order.orderNumber} updated to completed`);
            }
        }

        res.json({
            success: true,
            data: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                paymentStatus: order.paymentStatus,
                orderStatus: order.status,
                zenopayStatus: statusResult
            }
        });

    } catch (error) {
        console.error('Error checking payment status:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * Test endpoint to verify webhook is accessible
 */
exports.testWebhook = (req, res) => {
    // console.log('Webhook test endpoint hit');
    res.json({
        success: true,
        message: 'Webhook endpoint is accessible',
        timestamp: new Date().toISOString()
    });
};