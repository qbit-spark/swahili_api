const Product = require('../models/Product');
const Shop = require('../models/Shop');
const ProductView = require('../models/ProductView');

const isNewView = async (productId, ip, userId) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const query = {
    product: productId,
    timestamp: { $gte: twentyFourHoursAgo },
    $or: [{ ip }]
  };

  // Only add user condition if we actually have a userId
  if (userId) query.$or.push({ user: userId });

  const existing = await ProductView.findOne(query);
  return !existing;
};

const trackView = async (productId, ip, userId) => {
  // Always increment total views atomically
  await Product.findByIdAndUpdate(productId, { $inc: { 'views.total': 1 } });

  // Only count unique + record history if genuinely new
  if (await isNewView(productId, ip, userId)) {
    await Product.findByIdAndUpdate(productId, { $inc: { 'views.unique': 1 } });

    // Record in separate collection (TTL handles cleanup automatically)
    await ProductView.create({
      product: productId,
      ip,
      user: userId || null
    });
  }
};

exports.createProduct = async (req, res) => {
  try {
    // First check if the user has a shop
    const shop = await Shop.findOne({ owner: req.user.id });
    if (!shop) {
      return res.status(400).json({
        success: false,
        errors: ['You must create a shop before adding products'],
        data: null
      });
    }

    // Validate input
    const { name, price, category } = req.body;
    const errors = [];

    if (!name) errors.push('Product name is required');
    if (!price) errors.push('Price is required');
    if (!category) errors.push('Category is required');

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: errors,
        data: null
      });
    }

    // Create new product with the shop ID
    const product = new Product({
      ...req.body,
      shop: shop._id  // Use the shop's ID
    });

    await product.save();

    // Update shop metrics - increment total products
    await Shop.findByIdAndUpdate(
      shop._id,
      { $inc: { 'metrics.totalProducts': 1 } }
    );

    res.status(201).json({
      success: true,
      data: { product },
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

exports.getAllProducts = async (req, res) => {
  try {
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skipIndex = (page - 1) * limit;

    // Filtering and searching
    const filter = {};
    if (req.query.category) {
      filter.category = req.query.category;
    }
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }

    // Sorting
    const sortField = req.query.sortBy || 'createdAt';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;
    const sort = { [sortField]: sortOrder };

    // Query products with pagination
    const totalProducts = await Product.countDocuments(filter);
    const products = await Product.find(filter)
      .populate('category', 'name')
      .populate('shop', 'name')
      .sort(sort)
      .limit(limit)
      .skip(skipIndex);

    res.json({
      success: true,
      data: {
        products,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalProducts / limit),
          totalProducts,
          limit
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


exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('category', 'name')
      .populate('shop', 'name');

    if (!product) {
      return res.status(404).json({ success: false, errors: ['Product not found'], data: null });
    }

    // Fire-and-forget — don't block the response on view tracking
    const ip = req.ip;
    const userId = req.user ? req.user._id : null;
    trackView(product._id, ip, userId).catch(err =>
      console.error('View tracking error:', err)
    );

    res.json({ success: true, data: { product }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, errors: [err.message], data: null });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        errors: ['Product not found'],
        data: null
      });
    }

    res.json({
      success: true,
      data: { product },
      errors: []
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      errors: [err.message],
      data: null
    });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        errors: ['Product not found'],
        data: null
      });
    }

    // Store shop ID before deleting
    const shopId = product.shop;

    // Delete the product
    await Product.findByIdAndDelete(req.params.id);

    // Update shop metrics - decrement total products
    await Shop.findByIdAndUpdate(
      shopId,
      { $inc: { 'metrics.totalProducts': -1 } }
    );

    res.json({
      success: true,
      data: { message: 'Product deleted successfully' },
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

exports.trackProductView = async (req, res) => {
  try {
    const { productId } = req.params;
    const ip = req.ip;
    const userId = req.user ? req.user._id : null;

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ success: false, errors: ['Product not found'], data: null });
    }

    await trackView(productId, ip, userId);

    // Re-fetch updated counts
    const updated = await Product.findById(productId).select('views.total views.unique');

    res.json({
      success: true,
      data: { views: { total: updated.views.total, unique: updated.views.unique } },
      errors: []
    });
  } catch (err) {
    res.status(500).json({ success: false, errors: [err.message], data: null });
  }
};

exports.getProductViewStats = async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await Product.findById(productId)
      .select('views.total views.unique');

    if (!product) {
      return res.status(404).json({
        success: false,
        errors: ['Product not found'],
        data: null
      });
    }

    res.json({
      success: true,
      data: {
        views: {
          total: product.views.total,
          unique: product.views.unique
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