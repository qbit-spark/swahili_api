require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { User } = require('../src/models/User');
const Category = require('../src/models/Category');

mongoose.set('strictQuery', false);

/**
 * ADMIN
 */
const adminUser = {
  username: 'admin',
  email: 'admin@swahilifamily.com',
  password: 'admin123',
  userType: 'ADMIN',
  status: 'active',
  profile: {
    firstName: 'System',
    lastName: 'Administrator'
  }
};

/**
 * PARENT CATEGORIES
 * NOTE: slug is optional because schema auto-generates it
 */
const initialCategories = [
  {
    name: 'Electronics',
    description: 'Electronic devices and accessories',
    image: 'https://res.cloudinary.com/demo/image/upload/electronics.jpg',
    isActive: true,
    displayOrder: 1,
    attributes: [
      { name: 'Brand', type: 'text', required: true },
      { name: 'Model', type: 'text', required: true },
      { name: 'Condition', type: 'select', required: true, options: ['New', 'Used', 'Refurbished'] }
    ]
  },
  {
    name: 'Fashion',
    description: 'Clothing, shoes, and accessories',
    image: 'https://res.cloudinary.com/demo/image/upload/fashion.jpg',
    isActive: true,
    displayOrder: 2,
    attributes: [
      { name: 'Size', type: 'select', required: true, options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
      { name: 'Color', type: 'text', required: true },
      { name: 'Material', type: 'text', required: true }
    ]
  },
  {
    name: 'Home & Garden',
    description: 'Furniture, decor, and gardening supplies',
    image: 'https://res.cloudinary.com/demo/image/upload/home.jpg',
    isActive: true,
    displayOrder: 3,
    attributes: [
      { name: 'Material', type: 'text', required: true },
      { name: 'Dimensions', type: 'text', required: true }
    ]
  },
  {
    name: 'Books',
    description: 'Books, textbooks, and educational materials',
    image: 'https://res.cloudinary.com/demo/image/upload/books.jpg',
    isActive: true,
    displayOrder: 4,
    attributes: [
      { name: 'ISBN', type: 'text', required: true },
      { name: 'Author', type: 'text', required: true },
      { name: 'Format', type: 'select', required: true, options: ['Paperback', 'Hardcover', 'Digital'] }
    ]
  },
  {
    name: 'Sports & Fitness',
    description: 'Sports equipment and fitness gear',
    image: 'https://res.cloudinary.com/demo/image/upload/sports.jpg',
    isActive: true,
    displayOrder: 5,
    attributes: [
      { name: 'Type', type: 'text', required: true },
      { name: 'Size', type: 'text', required: false }
    ]
  },
  {
    name: 'Beauty & Health',
    description: 'Beauty products and health supplies',
    image: 'https://res.cloudinary.com/demo/image/upload/beauty.jpg',
    isActive: true,
    displayOrder: 6,
    attributes: [
      { name: 'Brand', type: 'text', required: true },
      { name: 'Volume/Weight', type: 'text', required: true },
      { name: 'Expiry Date', type: 'date', required: true }
    ]
  },
  {
    name: 'Automotive',
    description: 'Car parts and accessories',
    image: 'https://res.cloudinary.com/demo/image/upload/automotive.jpg',
    isActive: true,
    displayOrder: 7,
    attributes: [
      { name: 'Make', type: 'text', required: true },
      { name: 'Model', type: 'text', required: true },
      { name: 'Year', type: 'number', required: true }
    ]
  },
  {
    name: 'Toys & Games',
    description: 'Toys, games, and entertainment items',
    image: 'https://res.cloudinary.com/demo/image/upload/toys.jpg',
    isActive: true,
    displayOrder: 8,
    attributes: [
      { name: 'Age Range', type: 'text', required: true },
      { name: 'Category', type: 'select', required: true, options: ['Educational', 'Action Figures', 'Board Games', 'Outdoor'] }
    ]
  },
  {
    name: 'Food & Beverages',
    description: 'Food items and beverages',
    image: 'https://res.cloudinary.com/demo/image/upload/food.jpg',
    isActive: true,
    displayOrder: 9,
    attributes: [
      { name: 'Type', type: 'select', required: true, options: ['Fresh', 'Packaged', 'Frozen'] },
      { name: 'Weight', type: 'text', required: true },
      { name: 'Expiry Date', type: 'date', required: true }
    ]
  },
  {
    name: 'Art & Crafts',
    description: 'Art supplies and craft materials',
    image: 'https://res.cloudinary.com/demo/image/upload/art.jpg',
    isActive: true,
    displayOrder: 10,
    attributes: [
      { name: 'Medium', type: 'text', required: true },
      { name: 'Material', type: 'text', required: true }
    ]
  }
];

/**
 * SUBCATEGORIES (parentSlug based mapping)
 */
const initialSubCategories = [
  { name: 'Mobile Phones', slug: 'mobile-phones', parentSlug: 'electronics' },
  { name: 'Laptops', slug: 'laptops', parentSlug: 'electronics' },
  { name: 'Audio', slug: 'audio', parentSlug: 'electronics' },
  { name: 'TV & Displays', slug: 'tv-displays', parentSlug: 'electronics' },
  { name: 'Accessories', slug: 'electronics-accessories', parentSlug: 'electronics' },
  { name: 'Smart Devices', slug: 'smart-devices', parentSlug: 'electronics' },

  { name: 'Men Clothing', slug: 'men-clothing', parentSlug: 'fashion' },
  { name: 'Women Clothing', slug: 'women-clothing', parentSlug: 'fashion' },
  { name: 'Shoes', slug: 'shoes', parentSlug: 'fashion' },
  { name: 'Fashion Accessories', slug: 'fashion-accessories', parentSlug: 'fashion' },
  { name: 'Kids Fashion', slug: 'kids-fashion', parentSlug: 'fashion' },

  { name: 'Furniture', slug: 'furniture', parentSlug: 'home-garden' },
  { name: 'Kitchen & Dining', slug: 'kitchen-dining', parentSlug: 'home-garden' },
  { name: 'Home Decor', slug: 'home-decor', parentSlug: 'home-garden' },
  { name: 'Garden & Outdoor', slug: 'garden-outdoor', parentSlug: 'home-garden' },

  { name: 'Fiction', slug: 'fiction', parentSlug: 'books' },
  { name: 'Non-Fiction', slug: 'non-fiction', parentSlug: 'books' },
  { name: 'Educational Books', slug: 'educational-books', parentSlug: 'books' },
  { name: 'Children Books', slug: 'children-books', parentSlug: 'books' },

  { name: 'Gym Equipment', slug: 'gym-equipment', parentSlug: 'sports-fitness' },
  { name: 'Sports Gear', slug: 'sports-gear', parentSlug: 'sports-fitness' },
  { name: 'Outdoor Sports', slug: 'outdoor-sports', parentSlug: 'sports-fitness' },
  { name: 'Sportswear', slug: 'sportswear', parentSlug: 'sports-fitness' },

  { name: 'Skincare', slug: 'skincare', parentSlug: 'beauty-health' },
  { name: 'Hair Care', slug: 'hair-care', parentSlug: 'beauty-health' },
  { name: 'Makeup', slug: 'makeup', parentSlug: 'beauty-health' },
  { name: 'Personal Care', slug: 'personal-care', parentSlug: 'beauty-health' },

  { name: 'Car Parts', slug: 'car-parts', parentSlug: 'automotive' },
  { name: 'Car Accessories', slug: 'car-accessories', parentSlug: 'automotive' },
  { name: 'Car Electronics', slug: 'car-electronics', parentSlug: 'automotive' },

  { name: 'Toys', slug: 'toys', parentSlug: 'toys-games' },
  { name: 'Games', slug: 'games', parentSlug: 'toys-games' },
  { name: 'Outdoor Toys', slug: 'outdoor-toys', parentSlug: 'toys-games' },

  { name: 'Fresh Food', slug: 'fresh-food', parentSlug: 'food-beverages' },
  { name: 'Packaged Food', slug: 'packaged-food', parentSlug: 'food-beverages' },
  { name: 'Beverages', slug: 'beverages', parentSlug: 'food-beverages' },

  { name: 'Painting Supplies', slug: 'painting-supplies', parentSlug: 'art-crafts' },
  { name: 'Drawing Tools', slug: 'drawing-tools', parentSlug: 'art-crafts' },
  { name: 'Craft Materials', slug: 'craft-materials', parentSlug: 'art-crafts' }
];

async function seedDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // ---------------- ADMIN ----------------
    const existingAdmin = await User.findOne({ email: adminUser.email });

    if (!existingAdmin) {
      const hashed = await bcrypt.hash(adminUser.password, 10);
      await User.create({ ...adminUser, password: hashed });
      console.log('Admin created');
    } else {
      console.log('Admin already exists');
    }

    // ---------------- CATEGORIES ----------------
    const categoryMap = {};

    for (const cat of initialCategories) {
      let category = await Category.findOne({ name: cat.name });

      if (!category) {
        category = await Category.create(cat);
        console.log(`Created category: ${cat.name}`);
      } else {
        console.log(`Category exists: ${cat.name}`);
      }

      categoryMap[category.slug] = category;
    }

    // ---------------- SUBCATEGORIES ----------------
    for (const sub of initialSubCategories) {
      const parent = categoryMap[sub.parentSlug];
      if (!parent) continue;

      let subCategory = await Category.findOne({ slug: sub.slug });

      if (!subCategory) {
        subCategory = await Category.create({
          name: sub.name,
          description: `${sub.name} subcategory`,
          image: parent.image,
          isActive: true,
          displayOrder: 1,
          parentCategory: parent._id,
          level: 2,
          attributes: []
        });

        console.log(`Created subcategory: ${sub.name}`);
      } else {
        console.log(`Subcategory exists: ${sub.name}`);
      }
    }

    console.log('Seeding complete');
  } catch (err) {
    console.error('Seed error:', err);
  } finally {
    await mongoose.connection.close();
    console.log('DB closed');
  }
}

seedDB();