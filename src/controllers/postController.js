const Post = require('../models/Post');
const { uploadToCloudinary, deleteTempFile, cloudinary } = require('../config/cloudinary');
const { parseImage } = require('../middleware/multer');
const { emitPostViewSignal, emitPostEngageSignal } = require('../queues/exploreQueue');

const fireSignal = (fn) => fn().catch((e) => console.error('[PostSignal]', e.message));

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/posts
 * multipart/form-data: image (file) + caption, tags, category, taggedProducts, status
 */
exports.createPost = async (req, res) => {
  try {
    await parseImage(req, res);

    const { caption, category, status } = req.body;
    const tags =
  typeof req.body.tags === 'string'
    ? JSON.parse(req.body.tags || '[]')
    : req.body.tags || [];

const taggedProducts =
  typeof req.body.taggedProducts === 'string'
    ? JSON.parse(req.body.taggedProducts || '[]')
    : req.body.taggedProducts || [];

    if (!caption?.trim()) {
      return res.status(400).json({ success: false, errors: ['Caption is required'], data: null });
    }

    let image = {};
    if (req.file) {
      const url = await uploadToCloudinary(req.file, 'posts');
      await deleteTempFile(req.file.path);
      // extracting publicId from URL for later deletion
      const publicId = url.split('/').slice(-2).join('/').replace(/\.[^/.]+$/, '');
      image = { url, publicId };
    }

    const post = await Post.create({
      seller: req.user.id,
      shop: req.shop?._id || null,
      caption: caption.trim(),
      tags,
      category: category || null,
      taggedProducts,
      status: status || 'published',
      image,
    });

    res.status(201).json({ success: true, data: { post }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Read ─────────────────────────────────────────────────────────────────────

exports.getAllPosts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(40, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = { status: 'published' };
    if (req.query.seller) filter.seller = req.query.seller;
    if (req.query.shop) filter.shop = req.query.shop;
    if (req.query.category) filter.category = req.query.category;

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .populate('seller', 'profile.firstName profile.lastName profile.avatar')
        .populate('shop', 'name')
        .populate('category', 'name')
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Post.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { posts, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), total, limit } },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.getPostById = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('seller', 'profile.firstName profile.lastName profile.avatar')
      .populate('shop', 'name')
      .populate('category', 'name')
      .populate('taggedProducts', 'name price images');

    if (!post) {
      return res.status(404).json({ success: false, errors: ['Post not found'], data: null });
    }

    const userId = req.user?._id || null;
    fireSignal(() => emitPostViewSignal(post._id, userId, post.category?._id || post.category));

    res.json({ success: true, data: { post }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Update ───────────────────────────────────────────────────────────────────

exports.updatePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ success: false, errors: ['Post not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && post.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    await parseImage(req, res);

    if (req.file) {
      // Delete old Cloudinary asset
      if (post.image?.publicId) {
        await cloudinary.uploader.destroy(post.image.publicId).catch(() => { });
      }
      const url = await uploadToCloudinary(req.file, 'posts');
      await deleteTempFile(req.file.path);
      const publicId = url.split('/').slice(-2).join('/').replace(/\.[^/.]+$/, '');
      post.image = { url, publicId };
    }

    const { caption, category, status } = req.body;
    if (caption) post.caption = caption.trim();
    if (category) post.category = category;
    if (status) post.status = status;
    if (req.body.tags) post.tags = JSON.parse(req.body.tags);
    if (req.body.taggedProducts) post.taggedProducts = JSON.parse(req.body.taggedProducts);

    await post.save();
    res.json({ success: true, data: { post }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Delete ───────────────────────────────────────────────────────────────────

exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ success: false, errors: ['Post not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && post.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    if (post.image?.publicId) {
      await cloudinary.uploader.destroy(post.image.publicId).catch(() => { });
    }

    await Post.findByIdAndDelete(req.params.id);
    res.json({ success: true, data: { message: 'Post deleted' }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Like / Unlike ────────────────────────────────────────────────────────────

exports.toggleLike = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        errors: ['Post not found'],
        data: null,
      });
    }

    const userId = req.user._id;

    const hasLiked = post.likedBy.some((id) => id.equals(userId));

    if (hasLiked) {
      await Post.findByIdAndUpdate(req.params.id, {
        $pull: { likedBy: userId },
        $inc: { 'engagement.likes': -1 },
      });
    } else {
      await Post.findByIdAndUpdate(req.params.id, {
        $addToSet: { likedBy: userId },
        $inc: { 'engagement.likes': 1 },
      });

      fireSignal(() =>
        emitPostEngageSignal(
          post._id,
          userId,
          post.category?._id || post.category,
          'like'
        )
      );
    }

    const updated = await Post.findById(req.params.id)
      .select('engagement.likes');

    return res.json({
      success: true,
      data: {
        liked: !hasLiked,
        likeCount: updated.engagement.likes,
      },
      errors: [],
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      data: null,
      errors: [err.message],
    });
  }
};