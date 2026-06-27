const Category = require('../models/Category');
const Product = require('../models/Product');
const { uploadToCloudinary } = require('../config/cloudinary');

// Validation helper
const validateCategoryInput = (data) => {
  const errors = [];

  if (!data.name) errors.push('Category name is required');
  if (!data.description) errors.push('Description is required');

  return errors;
};

exports.createCategory = async (req, res) => {
  try {
    // Validate input
    const errors = validateCategoryInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors,
        data: null
      });
    }

    // Check if category already exists
    const existingCategory = await Category.findOne({ name: req.body.name });
    if (existingCategory) {
      return res.status(400).json({
        success: false,
        errors: ['Category with this name already exists'],
        data: null
      });
    }

    // Handle image upload
    let imageUrl = '';
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file, 'category-images');
    }

    // If it's a subcategory, update parent and level
    let level = 1;
    if (req.body.parentCategory) {
      const parentCategory = await Category.findById(req.body.parentCategory);
      if (!parentCategory) {
        return res.status(400).json({
          success: false,
          errors: ['Parent category not found'],
          data: null
        });
      }
      level = parentCategory.level + 1;

      // Update parent's subcategories
      await Category.findByIdAndUpdate(
        req.body.parentCategory,
        { $push: { subCategories: parentCategory._id } }
      );
    }

    const category = new Category({
      ...req.body,
      image: imageUrl,
      level
    });

    await category.save();

    res.status(201).json({
      success: true,
      data: { category },
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

exports.getAllCategories = async (req, res) => {
  try {
    const {
      parentOnly,
      includeInactive,
      search,
      sort = 'displayOrder'
    } = req.query;

    let query = {};

    // Search by name
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    // Filter active/inactive
    if (!includeInactive) {
      query.isActive = true;
    }

    // Filter parent categories only
    if (parentOnly === 'true') {
      query.parentCategory = null;
    }

    // Get categories
    const categories = await Category.find(query)
      .populate('parentCategory', 'name')
      .populate('subCategories', 'name')
      .sort(sort);

    // Get product counts for each category
    const categoriesWithCounts = await Promise.all(
      categories.map(async (category) => {
        const [productCount, activeProductCount] = await Promise.all([
          Product.countDocuments({ category: category._id }),
          Product.countDocuments({ category: category._id, isActive: true })
        ]);
        
        const categoryObj = category.toObject();
        return {
          ...categoryObj,
          metadata: {
            productCount,
            activeProductCount
          }
        };
      })
    );

    res.json({
      success: true,
      data: { categories: categoriesWithCounts },
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

exports.getCategoryById = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id)
      .populate('parentCategory', 'name')
      .populate('subCategories', 'name');

    if (!category) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Category not found']
      });
    }

    // Get both total and active product counts
    const [productCount, activeProductCount] = await Promise.all([
      Product.countDocuments({ category: category._id }),
      Product.countDocuments({ category: category._id, isActive: true })
    ]);

    const categoryObj = category.toObject();
    
    res.json({
      success: true,
      data: { 
        category: {
          ...categoryObj,
          metadata: {
            productCount,
            activeProductCount
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

exports.updateCategory = async (req, res) => {
  try {
    const errors = validateCategoryInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        data: null,
        errors
      });
    }

    // Handle image upload if provided
    if (req.file) {
      req.body.image = await uploadToCloudinary(req.file, 'category-images');
    }

    const category = await Category.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).populate('parentCategory', 'name')
      .populate('subCategories', 'name');

    if (!category) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Category not found']
      });
    }

    res.json({
      success: true,
      errors: [],
      data: { category }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    // Check if category has products
    const productsCount = await Product.countDocuments({
      category: req.params.id
    });

    if (productsCount > 0) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Cannot delete category with existing products']
      });
    }

    // Check if category has subcategories
    const hasSubcategories = await Category.exists({
      parentCategory: req.params.id
    });

    if (hasSubcategories) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Cannot delete category with existing subcategories']
      });
    }

    const category = await Category.findByIdAndDelete(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Category not found']
      });
    }

    // If category had a parent, update parent's subcategories
    if (category.parentCategory) {
      await Category.findByIdAndUpdate(
        category.parentCategory,
        { $pull: { subCategories: category._id } }
      );
    }

    res.json({
      success: true,
      data: { message: 'Category deleted successfully' },
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

exports.getCategoryProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sortBy || 'createdAt';
    const order = req.query.order === 'asc' ? 1 : -1;

    const products = await Product.find({ category: req.params.id })
      .populate('shop', 'name verificationStatus')
      .sort({ [sortBy]: order })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Product.countDocuments({ category: req.params.id });

    res.json({
      success: true,
      errors: [],
      data: {
        products,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          totalRecords: total
        }
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

exports.updateCategoryStatus = async (req, res) => {
  try {
    const { isActive } = req.body;

    const category = await Category.findByIdAndUpdate(
      req.params.id,
      { isActive, updatedAt: Date.now() },
      { new: true }
    );

    if (!category) {
      return res.status(404).json({
        success: false,
        data: null,
        errors: ['Category not found']
      });
    }

    res.json({
      success: true,
      data: { category },
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

exports.reorderCategories = async (req, res) => {
  try {
    const { orders } = req.body; // Array of { id, displayOrder }

    if (!Array.isArray(orders)) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['Invalid input format']
      });
    }

    await Promise.all(
      orders.map(({ id, displayOrder }) =>
        Category.findByIdAndUpdate(id, { displayOrder })
      )
    );

    res.json({
      success: true,
      data: { message: 'Categories reordered successfully' },
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