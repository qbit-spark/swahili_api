const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema(
  {
    askedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    question: {
      type: String,
      required: true,
      maxlength: 500,
      trim: true,
    },
    answer: {
      type: String,
      maxlength: 2000,
      trim: true,
    },
    answeredAt: Date,
    // Vote/upvote tracking
    upvotes:   { type: Number, default: 0, min: 0 },
    upvotedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    isAnswered: { type: Boolean, default: false, index: true },
    isPinned:   { type: Boolean, default: false },
  },
  { timestamps: true }
);

const amaSchema = new mongoose.Schema(
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
      maxlength: 1000,
      trim: true,
    },
    // Optional cover image
    coverImage: {
      url:      { type: String },
      publicId: { type: String },
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      index: true,
    },
    status: {
      type: String,
      enum: ['scheduled', 'open', 'closed'],
      default: 'scheduled',
      index: true,
    },
    scheduledFor: { type: Date },
    openedAt:     { type: Date },
    closedAt:     { type: Date },

    questions: [questionSchema],

    engagement: {
      participants:   { type: Number, default: 0, min: 0 },
      totalQuestions: { type: Number, default: 0, min: 0 },
      answeredCount:  { type: Number, default: 0, min: 0 },
      views:          { type: Number, default: 0, min: 0 },
      likes:          { type: Number, default: 0, min: 0 },
    },

    // AMA-level likes (separate from question upvotes)
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    _exploreScore: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

amaSchema.index({ _exploreScore: -1, _id: -1 });
amaSchema.index({ status: 1, _exploreScore: -1 });
amaSchema.index({ status: 1, closedAt: -1 });
amaSchema.index({ seller: 1, createdAt: -1 });

module.exports =
  mongoose.models.AMA ||
  mongoose.model('AMA', amaSchema);