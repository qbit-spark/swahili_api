const AMA = require('../models/Ama');
const { uploadToCloudinary, deleteTempFile, cloudinary } = require('../config/cloudinary');
const { parseImage } = require('../middleware/multer');
const { emitAmaViewSignal, emitAmaQuestionSignal } = require('../queues/exploreQueue');
const { enrichResponseItem } = require('../utils/shopResponse');

const fireSignal = (fn) => fn().catch((e) => console.error('[AMASignal]', e.message));

// ─── Create ───────────────────────────────────────────────────────────────────

exports.createAMA = async (req, res) => {
  try {
    await parseImage(req, res);

    const { title, description, category, scheduledFor } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ success: false, errors: ['Title is required'], data: null });
    }

    let coverImage = {};
    if (req.file) {
      const url      = await uploadToCloudinary(req.file, 'amas');
      await deleteTempFile(req.file.path);
      const publicId = url.split('/').slice(-2).join('/').replace(/\.[^/.]+$/, '');
      coverImage     = { url, publicId };
    }

    const ama = await AMA.create({
      seller:      req.user.id,
      shop:        req.shop?._id || null,
      title:       title.trim(),
      description: description?.trim() || '',
      category:    category || null,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      status:      scheduledFor ? 'scheduled' : 'open',
      openedAt:    scheduledFor ? null : new Date(),
      coverImage,
    });

    res.status(201).json({ success: true, data: { ama }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Read ─────────────────────────────────────────────────────────────────────

exports.getAllAMAs = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(40, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.status)   filter.status   = req.query.status;
    if (req.query.seller)   filter.seller   = req.query.seller;
    if (req.query.shop)     filter.shop     = req.query.shop;
    if (req.query.category) filter.category = req.query.category;
    if (!req.query.status)  filter.status   = { $in: ['open', 'scheduled'] };

    const [amas, total] = await Promise.all([
      AMA.find(filter)
        .populate('seller',  'profile.firstName profile.lastName profile.avatar')
        .populate('shop',    'name verificationStatus')
        .populate('category','name')
        .select('-questions')
        .sort({ status: 1, scheduledFor: 1, createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      AMA.countDocuments(filter),
    ]);

    const normalizedAmas = await Promise.all(amas.map((ama) => enrichResponseItem(ama)));

    res.json({
      success: true,
      data: { amas: normalizedAmas, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), total, limit } },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.getAMAById = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id)
      .populate('seller',  'profile.firstName profile.lastName profile.avatar')
      .populate('shop',    'name verificationStatus')
      .populate('category','name')
      .populate('questions.askedBy', 'profile.firstName profile.lastName profile.avatar');

    if (!ama) {
      return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });
    }

    ama.questions.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return b.isPinned - a.isPinned;
      if (b.upvotes !== a.upvotes)   return b.upvotes - a.upvotes;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    const userId = req.user?._id || null;
    fireSignal(() => emitAmaViewSignal(ama._id, userId, ama.category?._id || ama.category));
    AMA.findByIdAndUpdate(req.params.id, { $inc: { 'engagement.views': 1 } })
      .catch((e) => console.error('[AMA view inc]', e.message));

    res.json({ success: true, data: { ama }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Update ───────────────────────────────────────────────────────────────────

exports.updateAMA = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) {
      return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && ama.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    await parseImage(req, res);

    if (req.file) {
      if (ama.coverImage?.publicId) {
        await cloudinary.uploader.destroy(ama.coverImage.publicId).catch(() => {});
      }
      const url      = await uploadToCloudinary(req.file, 'amas');
      await deleteTempFile(req.file.path);
      const publicId = url.split('/').slice(-2).join('/').replace(/\.[^/.]+$/, '');
      ama.coverImage = { url, publicId };
    }

    const { title, description, category, scheduledFor } = req.body;
    if (title)       ama.title       = title.trim();
    if (description) ama.description = description.trim();
    if (category)    ama.category    = category;
    if (scheduledFor && ama.status === 'scheduled') {
      ama.scheduledFor = new Date(scheduledFor);
    }

    await ama.save();
    res.json({ success: true, data: { ama }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

exports.openAMA = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    if (req.user.userType !== 'ADMIN' && ama.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    if (ama.status !== 'open') {
      ama.status   = 'open';
      ama.openedAt = new Date();
      await ama.save();
    }

    res.json({ success: true, data: { ama }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.closeAMA = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    if (req.user.userType !== 'ADMIN' && ama.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    ama.status   = 'closed';
    ama.closedAt = new Date();
    await ama.save();
    res.json({ success: true, data: { ama }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Delete ───────────────────────────────────────────────────────────────────

exports.deleteAMA = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    if (req.user.userType !== 'ADMIN' && ama.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    if (ama.coverImage?.publicId) {
      await cloudinary.uploader.destroy(ama.coverImage.publicId).catch(() => {});
    }

    await AMA.findByIdAndDelete(req.params.id);
    res.json({ success: true, data: { message: 'AMA deleted' }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Questions ────────────────────────────────────────────────────────────────

exports.submitQuestion = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    if (ama.status !== 'open') {
      return res.status(400).json({
        success: false,
        errors: ['This AMA is not currently accepting questions'],
        data: null,
      });
    }

    const { question } = req.body;
    if (!question?.trim()) {
      return res.status(400).json({ success: false, errors: ['Question is required'], data: null });
    }

    await AMA.findByIdAndUpdate(req.params.id, {
      $push: { questions: { $each: [{ askedBy: req.user._id, question: question.trim() }], $position: 0 } },
      $inc:  { 'engagement.totalQuestions': 1, 'engagement.participants': 1 },
    });

    fireSignal(() =>
      emitAmaQuestionSignal(ama._id, req.user._id, ama.category?._id || ama.category)
    );

    const updated = await AMA.findById(req.params.id)
      .select('questions engagement')
      .populate('questions.askedBy', 'profile.firstName profile.lastName profile.avatar');

    res.status(201).json({
      success: true,
      data: { question: updated.questions[0], totalQuestions: updated.engagement.totalQuestions },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.answerQuestion = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    if (req.user.userType !== 'ADMIN' && ama.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    const { answer } = req.body;
    if (!answer?.trim()) {
      return res.status(400).json({ success: false, errors: ['Answer is required'], data: null });
    }

    const question = ama.questions.id(req.params.questionId);
    if (!question) {
      return res.status(404).json({ success: false, errors: ['Question not found'], data: null });
    }

    const wasAnswered   = question.isAnswered;
    question.answer     = answer.trim();
    question.isAnswered = true;
    question.answeredAt = new Date();
    await ama.save();

    if (!wasAnswered) {
      await AMA.findByIdAndUpdate(req.params.id, { $inc: { 'engagement.answeredCount': 1 } });
    }

    res.json({ success: true, data: { question }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.pinQuestion = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    if (req.user.userType !== 'ADMIN' && ama.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    const question = ama.questions.id(req.params.questionId);
    if (!question) {
      return res.status(404).json({ success: false, errors: ['Question not found'], data: null });
    }

    question.isPinned = !question.isPinned;
    await ama.save();

    res.json({ success: true, data: { pinned: question.isPinned }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Likes ────────────────────────────────────────────────────────────────────

exports.toggleLike = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    const userId   = req.user._id;
    const hasLiked = ama.likes.some((id) => id.equals(userId));

    if (hasLiked) {
      await AMA.findByIdAndUpdate(req.params.id, { $pull: { likes: userId }, $inc: { 'engagement.likes': -1 } });
    } else {
      await AMA.findByIdAndUpdate(req.params.id, { $addToSet: { likes: userId }, $inc: { 'engagement.likes': 1 } });
    }

    const updated = await AMA.findById(req.params.id).select('engagement.likes');
    res.json({
      success: true,
      data: { liked: !hasLiked, likeCount: updated.engagement.likes },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.upvoteQuestion = async (req, res) => {
  try {
    const ama = await AMA.findById(req.params.id);
    if (!ama) return res.status(404).json({ success: false, errors: ['AMA not found'], data: null });

    const question = ama.questions.id(req.params.questionId);
    if (!question) {
      return res.status(404).json({ success: false, errors: ['Question not found'], data: null });
    }

    const userId     = req.user._id;
    const hasUpvoted = question.upvotedBy.some((id) => id.equals(userId));

    if (hasUpvoted) {
      question.upvotedBy.pull(userId);
      question.upvotes = Math.max(0, question.upvotes - 1);
    } else {
      question.upvotedBy.addToSet(userId);
      question.upvotes += 1;
    }

    await ama.save();
    res.json({
      success: true,
      data: { upvoted: !hasUpvoted, upvotes: question.upvotes },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};