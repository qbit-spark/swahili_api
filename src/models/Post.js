const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
      index: true,
    },
    caption: {
      type: String,
      required: true,
      maxlength: 2200,
      trim: true,
    },
    image: {
      url:      { type: String },   // Cloudinary URL
      publicId: { type: String },   // for deletion
    },
    tags: [{ type: String, lowercase: true, trim: true }],

    // Products tagged in this post
    taggedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'published',
      index: true,
    },

    // Engagement counters — updated atomically via $inc
    engagement: {
      likes:    { type: Number, default: 0, min: 0 },
      comments: { type: Number, default: 0, min: 0 },
      saves:    { type: Number, default: 0, min: 0 },
      shares:   { type: Number, default: 0, min: 0 },
      views:    { type: Number, default: 0, min: 0 },
    },

    // Users who liked this post — for toggle detection (like/unlike)
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Explore score — written by feed-builder worker
    _exploreScore: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

// Cursor-based pagination indexes
postSchema.index({ _exploreScore: -1, _id: -1 });
postSchema.index({ status: 1, _exploreScore: -1 });
postSchema.index({ seller: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);