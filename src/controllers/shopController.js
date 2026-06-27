const Shop = require('../models/Shop');
const Product = require('../models/Product');
const { User } = require('../models/User');
const { uploadToCloudinary } = require('../config/cloudinary');
const { ensureShopVerificationTier } = require('../utils/shopResponse');

// Validation helper
const validateShopInput = (data) => {
  const errors = [];

  if (!data.name) errors.push('Shop name is required');
  if (!data.description) errors.push('Description is required');
  if (!data.address?.street) errors.push('Street address is required');
  if (!data.address?.city) errors.push('City is required');
  // if (!data.address?.state) errors.push('State is required');
  if (!data.address?.country) errors.push('Country is required');
  // if (!data.address?.zipCode) errors.push('Zip code is required');
  if (!data.contactInfo?.email) errors.push('Contact email is required');
  if (!data.contactInfo?.phone) errors.push('Contact phone is required');

  return errors;
};

exports.createShop = async (req, res) => {
  try {
    // Check if user is a seller
    if (req.user.userType !== 'SELLER') {
      return res.status(403).json({
        success: false,
        errors: ['Only sellers can create shops'],
        data: null
      });
    }

    // Check if user already has a shop
    const existingShop = await Shop.findOne({ owner: req.user.id });
    if (existingShop) {
      return res.status(400).json({
        success: false,
        errors: ['You already have a shop'],
        data: null
      });
    }

    // Validate input
    const errors = validateShopInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors,
        data: null
      });
    }

    // Handle logo upload if provided
    let logoUrl = '';
    if (req.files?.logo) {
      logoUrl = await uploadToCloudinary(req.files.logo[0], 'shop-logos');
    }

    // Handle cover image upload if provided
    let coverImageUrl = '';
    if (req.files?.coverImage) {
      coverImageUrl = await uploadToCloudinary(req.files.coverImage[0], 'shop-covers');
    }

    const shop = new Shop({
      ...req.body,
      owner: req.user.id,
      logo: logoUrl,
      coverImage: coverImageUrl
    });

    await shop.save();

    // Update user's hasShop flag
    await User.findByIdAndUpdate(req.user.id, { hasShop: true });

    const normalizedShop = await ensureShopVerificationTier(shop);

    res.status(201).json({
      success: true,
      data: { shop: normalizedShop },
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

exports.getAllShops = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const sortBy = req.query.sortBy || "createdAt";
    const order = req.query.order === "asc" ? 1 : -1;
    const search = req.query.search || "";
    const category = req.query.category;
    const status = req.query.status || "active";

    const query = {
      status,
      name: {
        $regex: search,
        $options: "i",
      },
    };

    if (category) {
      query.categories = category;
    }

    // Verified shops first, then sort by requested field.
    const sort = {
      "verificationStatus.isVerified": -1,
      [sortBy]: order,
    };

    const [shops, total] = await Promise.all([
      Shop.find(query)
        .populate("owner", "username email profile")
        .populate("categories", "name")
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit),

      Shop.countDocuments(query),
    ]);

    const normalizedShops = await Promise.all(
      shops.map((shop) => ensureShopVerificationTier(shop))
    );

    return res.status(200).json({
      success: true,
      data: {
        shops: normalizedShops,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          totalRecords: total,
        },
      },
      errors: [],
    });
  } catch (err) {
    console.error("Get shops error:", err);

    return res.status(500).json({
      success: false,
      data: null,
      errors: [err.message],
    });
  }
};

exports.getUserShop = async (req, res) => {
  try {
    const shop = await Shop.findOne({ owner: req.user.id })
      .populate('categories', 'name');

    if (!shop) {
      return res.status(404).json({
        success: false,
        errors: ['No shop found for this user'],
        data: null
      });
    }

    if (!req.user.hasShop) {
      await User.findByIdAndUpdate(req.user.id, { hasShop: true });
    }
     // Calculate actual metrics
    const totalProducts = await Product.countDocuments({ shop: shop._id });
    
    // Update the shop object with real metrics
    shop.metrics.totalProducts = totalProducts;
    
    const normalizedShop = await ensureShopVerificationTier(shop);

    return res.json({
      success: true,
      errors: [],
      data: { shop: normalizedShop }
    });
  } catch (error) {
    console.error('Get user shop error:', error);
    return res.status(500).json({
      success: false,
      errors: [error.message],
      data: null
    });
  }
};

exports.getShopById = async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id)
      .populate('owner', 'username email profile')
      .populate('categories', 'name');

    if (!shop) {
      return res.status(404).json({
        success: false,
        errors: ['Shop not found'],
        data: null
      });
    }

    const normalizedShop = await ensureShopVerificationTier(shop);

    res.json({
      success: true,
      data: { shop: normalizedShop },
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

exports.updateShop = async (req, res) => {
  try {
    // Validate input
    const errors = validateShopInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        data: null,
        errors
      });
    }

    // Handle file uploads if any
    if (req.files?.logo) {
      req.body.logo = await uploadToCloudinary(req.files.logo[0], 'shop-logos');
    }
    if (req.files?.coverImage) {
      req.body.coverImage = await uploadToCloudinary(req.files.coverImage[0], 'shop-covers');
    }

    const shop = await Shop.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.id },
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).populate('categories', 'name');

    if (!shop) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Shop not found or you are not the owner']
      });
    }

    const normalizedShop = await ensureShopVerificationTier(shop);

    res.json({
      success: true,
      data: { shop: normalizedShop },
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

exports.deleteShop = async (req, res) => {
  try {
    // Check if shop has any products
    const productsCount = await Product.countDocuments({ shop: req.params.id });
    if (productsCount > 0) {
      return res.status(400).json({
        success: false,
        errors: ['Cannot delete shop with existing products. Please delete all products first.'],
        data: null
      });
    }

    const shop = await Shop.findOneAndDelete({
      _id: req.params.id,
      owner: req.user.id
    });

    if (!shop) {
      return res.status(404).json({
        success: false,
        errors: ['Shop not found or you are not the owner'],
        data: null
      });
    }

    // Update user's hasShop flag
    await User.findByIdAndUpdate(req.user.id, { hasShop: false });

    res.json({
      success: true,
      errors: [],
      data: { message: 'Shop deleted successfully' }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      errors: [err.message],
      data: null
    });
  }
};

exports.getShopProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sortBy || 'createdAt';
    const order = req.query.order === 'asc' ? 1 : -1;
    const category = req.query.category;

    const query = { shop: req.params.id };
    if (category) {
      query.category = category;
    }

    const products = await Product.find(query)
      .populate('category', 'name')
      .sort({ [sortBy]: order })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Product.countDocuments(query);

    res.json({
      success: true,
      data: {
        products,
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

// New endpoints

exports.updateShopStatus = async (req, res) => {
  try {
    // Only admin can update shop status
    if (req.user.userType !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        errors: ['Only administrators can update shop status'],
        data: null
      });
    }

    const { status } = req.body;
    if (!['pending', 'active', 'suspended', 'closed'].includes(status)) {
      return res.status(400).json({
        success: false,
        errors: ['Invalid status'],
        data: null
      });
    }

    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: Date.now() },
      { new: true }
    );

    if (!shop) {
      return res.status(404).json({
        success: false,
        errors: ['Shop not found'],
        data: null
      });
    }

    res.json({
      success: true,
      errors: [],
      data: { shop }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      errors: [err.message],
      data: null
    });
  }
};

exports.updateShopVerification = async (req, res) => {
  try {
    // Only admin can verify shops
    if (req.user.userType !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        errors: ['Only administrators can verify shops'],
        data: null
      });
    }

    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      {
        'verificationStatus.isVerified': true,
        'verificationStatus.verifiedAt': Date.now(),
        updatedAt: Date.now()
      },
      { new: true }
    );

    if (!shop) {
      return res.status(404).json({
        success: false,
        errors: ['Shop not found'],
        data: null
      });
    }

    res.json({
      success: true,
      errors: [],
      data: { shop }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      errors: [err.message],
      data: null
    });
  }
};