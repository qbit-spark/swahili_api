const Rating = require('../models/Rating');
const Product = require('../models/Product');
const Order = require('../models/Order');

exports.createRating = async (req, res) => {
  try {
    const { productId, orderId, rating, review, images } = req.body;
    const userId = req.user._id;

    console.log("⭐ [Rating] Incoming request:", {
      productId,
      orderId,
      userId,
      rating,
    });

    // 1. Get order (ONLY check ownership + delivery first)
    const order = await Order.findOne({
      _id: orderId,
      user: userId,
      status: 'delivered',
    });

    if (!order) {
      console.log("❌ [Rating] Order not found or not delivered:", orderId);

      return res.status(400).json({
        success: false,
        errors: ['Can only rate products from delivered orders'],
        data: null,
      });
    }

    // 2. Validate product exists inside order (safe array check)
    const itemExists = order.items.some(
      (item) =>
        item.product?.toString?.() === productId.toString()
    );

    if (!itemExists) {
      console.log("❌ [Rating] Product not found in order:", {
        productId,
        orderItems: order.items.map((i) => i.product),
      });

      return res.status(400).json({
        success: false,
        errors: ['Product not found in this order'],
        data: null,
      });
    }

    // 3. Prevent duplicate rating
    const existingRating = await Rating.findOne({
      user: userId,
      product: productId,
      order: orderId,
    });

    if (existingRating) {
      console.log("⚠️ [Rating] Duplicate rating attempt");

      return res.status(400).json({
        success: false,
        errors: ['You have already rated this product'],
        data: null,
      });
    }

    // 4. Create rating
    const newRating = new Rating({
      user: userId,
      product: productId,
      order: orderId,
      rating,
      review,
      images: images || [],
    });

    await newRating.save();

    console.log("✅ [Rating] Created successfully:", newRating._id);

    return res.status(201).json({
      success: true,
      data: { rating: newRating },
      errors: [],
    });

  } catch (err) {
    console.error("💥 [Rating] Fatal error:", err);

    return res.status(500).json({
      success: false,
      errors: [err.message],
      data: null,
    });
  }
};

exports.getProductRatings = async (req, res) => {
  try {
    const { productId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const ratings = await Rating.find({ product: productId })
      .populate('user', 'username profile.avatar')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Rating.countDocuments({ product: productId });

    res.json({
      success: true,
      data: {
        ratings,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          totalRatings: total
        }
      },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      errors: [err.message],
      data: null
    });
  }
};

exports.updateRating = async (req, res) => {
  try {
    const { ratingId } = req.params;
    const { rating, review, images } = req.body;
    const userId = req.user._id;

    const existingRating = await Rating.findOne({
      _id: ratingId,
      user: userId
    });

    if (!existingRating) {
      return res.status(404).json({
        success: false,
        errors: ['Rating not found or not authorized'],
        data: null
      });
    }

    existingRating.rating = rating || existingRating.rating;
    existingRating.review = review || existingRating.review;
    existingRating.images = images || existingRating.images;
    existingRating.updatedAt = Date.now();

    await existingRating.save();

    res.json({
      success: true,
      data: { rating: existingRating },
      errors: []
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      errors: [err.message],
      data: null
    });
  }
};
