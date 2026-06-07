const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema(
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
    title: {
      type: String,
      required: true,
      maxlength: 200,
      trim: true,
    },
    description: {
      type: String,
      maxlength: 2200,
      trim: true,
    },
    video: {
      url:          { type: String, required: true },  // Cloudinary video URL
      publicId:     { type: String },                  // for deletion
      thumbnailUrl: { type: String },                  // Cloudinary eager thumbnail
      duration:     { type: Number },                  // seconds, set after upload
    },
    tags: [{ type: String, lowercase: true, trim: true }],
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      index: true,
    },
    taggedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    status: {
      type: String,
      enum: ['processing', 'published', 'archived'],
      default: 'processing',
      index: true,
    },
    engagement: {
      views:          { type: Number, default: 0, min: 0 },
      uniqueViews:    { type: Number, default: 0, min: 0 },
      likes:          { type: Number, default: 0, min: 0 },
      comments:       { type: Number, default: 0, min: 0 },
      saves:          { type: Number, default: 0, min: 0 },
      shares:         { type: Number, default: 0, min: 0 },
      totalWatchSeconds: { type: Number, default: 0 },
      completionCount:   { type: Number, default: 0 },
    },

    // Like toggle tracking
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    _exploreScore: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

videoSchema.index({ _exploreScore: -1, _id: -1 });
videoSchema.index({ status: 1, _exploreScore: -1 });
videoSchema.index({ seller: 1, createdAt: -1 });

module.exports = mongoose.model('Video', videoSchema);