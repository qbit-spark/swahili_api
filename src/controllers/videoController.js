const Video = require('../models/Video');
const { uploadToCloudinary, deleteTempFile, cloudinary } = require('../config/cloudinary');
const { parseVideo } = require('../middleware/multer');
const { emitVideoViewSignal, emitVideoEngageSignal } = require('../queues/exploreQueue');
const { enrichResponseItem } = require('../utils/shopResponse');

const fireSignal = (fn) => fn().catch((e) => console.error('[VideoSignal]', e.message));

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/videos
 * multipart/form-data: video (file) + title, description, tags, category, taggedProducts
 *
 * Your existing uploadToCloudinary uses allowed_formats for images.
 * For video we call cloudinary.uploader.upload directly with resource_type: 'video'
 * so we get duration + eager thumbnail in one shot.
 */
exports.createVideo = async (req, res) => {
  try {
    await parseVideo(req, res);

    if (!req.file) {
      return res.status(400).json({ success: false, errors: ['Video file is required'], data: null });
    }

    const { title, description, category } = req.body;
    const tags = JSON.parse(req.body.tags || '[]');
    const taggedProducts = JSON.parse(req.body.taggedProducts || '[]');

    if (!title?.trim()) {
      return res.status(400).json({ success: false, errors: ['Title is required'], data: null });
    }

    // Upload video directly — resource_type video, eager thumbnail at 3s
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'swahili_marketplace/videos',
      resource_type: 'video',
      eager: [
        { width: 640, height: 360, crop: 'fill', format: 'jpg', start_offset: '3' },
      ],
      eager_async: true,
    });

    await deleteTempFile(req.file.path);

    const eagerThumb = result.eager?.[0];

    const video = await Video.create({
      seller: req.user.id,
      shop: req.shop?._id || null,
      title: title.trim(),
      description: description?.trim() || '',
      tags,
      category: category || null,
      taggedProducts,
      video: {
        url: result.secure_url,
        publicId: result.public_id,
        duration: result.duration || null,
      },
      thumbnail: eagerThumb
        ? { url: eagerThumb.secure_url, publicId: eagerThumb.public_id }
        : {},
      status: 'processing',
    });

    res.status(201).json({
      success: true,
      data: { video, note: 'Video is processing. Call PATCH /:id/publish to make it live.' },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Publish ──────────────────────────────────────────────────────────────────

exports.publishVideo = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, errors: ['Video not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && video.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    if (video.status === 'published') {
      return res.json({ success: true, data: { video }, errors: [] });
    }

    const updates = { status: 'published' };
    if (req.body.thumbnailUrl) {
      updates['thumbnail.url'] = req.body.thumbnailUrl;
      updates['thumbnail.publicId'] = req.body.thumbnailPublicId || video.thumbnail?.publicId;
    }

    const updated = await Video.findByIdAndUpdate(req.params.id, updates, { new: true });
    res.json({ success: true, data: { video: updated }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Read ─────────────────────────────────────────────────────────────────────

exports.getAllVideos = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(40, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = { status: 'published' };
    if (req.query.seller) filter.seller = req.query.seller;
    if (req.query.shop) filter.shop = req.query.shop;
    if (req.query.category) filter.category = req.query.category;

    const [videos, total] = await Promise.all([
      Video.find(filter)
        .populate('seller', 'profile.firstName profile.lastName profile.avatar')
        .populate('shop', 'name verificationStatus')
        .populate('category', 'name')
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Video.countDocuments(filter),
    ]);

    const normalizedVideos = await Promise.all(videos.map((video) => enrichResponseItem(video)));

    res.json({
      success: true,
      data: { videos: normalizedVideos, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), total, limit } },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.getVideoById = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id)
      .populate('seller', 'profile.firstName profile.lastName profile.avatar')
      .populate('shop', 'name verificationStatus')
      .populate('category', 'name')
      .populate('taggedProducts', 'name price images');

    if (!video) {
      return res.status(404).json({ success: false, errors: ['Video not found'], data: null });
    }

    const userId = req.user?._id || null;

    Video.findByIdAndUpdate(req.params.id, {
      $inc: { 'engagement.views': 1, 'engagement.uniqueViews': 1 },
    }).catch((e) => console.error('[Video view inc]', e.message));

    fireSignal(() => emitVideoViewSignal(video._id, userId, video.category?._id || video.category));

    res.json({ success: true, data: { video }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Update ───────────────────────────────────────────────────────────────────

exports.updateVideo = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, errors: ['Video not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && video.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    const { title, description, category, status } = req.body;
    if (title) video.title = title.trim();
    if (description) video.description = description.trim();
    if (category) video.category = category;
    if (status && ['published', 'archived'].includes(status)) video.status = status;
    if (req.body.tags) {
      video.tags = req.body.tags;
    }

    if (req.body.taggedProducts) {
      video.taggedProducts = req.body.taggedProducts;
    }

    await video.save();
    res.json({ success: true, data: { video }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Delete ───────────────────────────────────────────────────────────────────

exports.deleteVideo = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, errors: ['Video not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && video.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    // Delete from Cloudinary — video + thumbnail
    await cloudinary.uploader.destroy(video.video.publicId, { resource_type: 'video' }).catch(() => { });
    if (video.thumbnail?.publicId) {
      await cloudinary.uploader.destroy(video.thumbnail.publicId).catch(() => { });
    }

    await Video.findByIdAndDelete(req.params.id);
    res.json({ success: true, data: { message: 'Video deleted' }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Like ─────────────────────────────────────────────────────────────────────

exports.toggleLike = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);

    if (!video) {
      return res.status(404).json({
        success: false,
        errors: ['Video not found'],
        data: null,
      });
    }

    const userId = req.user._id;

    const hasLiked = (video.likedBy || []).some((id) =>
      id.equals(userId)
    );

    if (hasLiked) {
      await Video.findByIdAndUpdate(req.params.id, {
        $pull: { likedBy: userId },
        $inc: { 'engagement.likes': -1 },
      });
    } else {
      await Video.findByIdAndUpdate(req.params.id, {
        $addToSet: { likedBy: userId },
        $inc: { 'engagement.likes': 1 },
      });

      fireSignal(() =>
        emitVideoEngageSignal(
          video._id,
          userId,
          video.category?._id || video.category,
          { engageType: 'like' }
        )
      );
    }

    const updated = await Video.findById(req.params.id)
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

// ─── Watch completion ─────────────────────────────────────────────────────────

exports.reportCompletion = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, errors: ['Video not found'], data: null });
    }

    await Video.findByIdAndUpdate(req.params.id, {
      $inc: { 'engagement.completionCount': 1 },
    });

    fireSignal(() =>
      emitVideoEngageSignal(video._id, req.user._id, video.category?._id || video.category, {
        completion: true,
      })
    );

    res.json({ success: true, data: { received: true }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};


