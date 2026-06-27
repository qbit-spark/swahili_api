const crypto  = require('crypto');
const Event   = require('../models/Event');
const { uploadToCloudinary, deleteTempFile } = require('../config/cloudinary');
const { parseImage } = require('../middleware/multer');
const { emitEventViewSignal, emitEventEngageSignal } = require('../queues/exploreQueue');

const fireSignal = (fn) => fn().catch((e) => console.error('[EventSignal]', e.message));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unique ticket code — 8 char uppercase hex */
const generateTicketCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

/** Parse JSON body fields that come in as strings from multipart forms */
const parseField = (val, fallback) => {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return val; }
};

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/events
 * multipart/form-data:
 *   image (optional file)
 *   title, description, type, startsAt, endsAt
 *   location (JSON string), virtual (JSON string)
 *   isFree, ticketTiers (JSON array)
 *   category, tags (JSON array), status, maxAttendees
 */
exports.createEvent = async (req, res) => {
  try {
    await parseImage(req, res);

    const {
      title, description, type, startsAt, endsAt,
      isFree, category, status, maxAttendees,
    } = req.body;

    // ── Validation ────────────────────────────────────────────────────────────
    const errors = [];
    if (!title)    errors.push('Title is required');
    if (!type)     errors.push('Event type is required (physical | virtual | hybrid)');
    if (!startsAt) errors.push('Start date is required');
    if (!endsAt)   errors.push('End date is required');
    if (new Date(startsAt) >= new Date(endsAt)) errors.push('End date must be after start date');
    if (errors.length) {
      return res.status(400).json({ success: false, errors, data: null });
    }

    const ticketTiers = parseField(req.body.ticketTiers, []);
    const location    = parseField(req.body.location,    {});
    const virtual     = parseField(req.body.virtual,     {});
    const tags        = parseField(req.body.tags,        []);

    // Physical/hybrid events must have a venue
    if (['physical', 'hybrid'].includes(type) && !location.venue) {
      return res.status(400).json({
        success: false,
        errors: ['Venue is required for physical and hybrid events'],
        data: null,
      });
    }

    // Upload banner if provided
    let banner = {};
    if (req.file) {
      const url = await uploadToCloudinary(req.file, 'events');
      await deleteTempFile(req.file.path);
      banner = { url, publicId: req.file.filename };
    }

    const event = await Event.create({
      seller:      req.user.id,
      shop:        req.shop?._id || null,
      title,
      description: description || '',
      type,
      location,
      virtual,
      startsAt:    new Date(startsAt),
      endsAt:      new Date(endsAt),
      banner,
      category:    category || null,
      tags,
      isFree:      isFree === 'true' || isFree === true,
      ticketTiers: ticketTiers,
      maxAttendees: maxAttendees ? parseInt(maxAttendees) : null,
      status:      status || 'published',
    });

    res.status(201).json({ success: true, data: { event }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Read ─────────────────────────────────────────────────────────────────────

const { enrichResponseItem } = require('../utils/shopResponse');

/**
 * GET /api/v1/events
 * Public — paginated, filterable
 * Query: type, status, category, upcoming (bool), seller, shop, page, limit
 */
exports.getAllEvents = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(40, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = { status: 'published' };
    if (req.query.type)     filter.type     = req.query.type;
    if (req.query.category) filter.category = req.query.category;
    if (req.query.seller)   filter.seller   = req.query.seller;
    if (req.query.shop)     filter.shop     = req.query.shop;

    // Upcoming only — default behaviour
    if (req.query.upcoming !== 'false') {
      filter.startsAt = { $gte: new Date() };
    }

    const [events, total] = await Promise.all([
      Event.find(filter)
        .populate('seller',  'profile.firstName profile.lastName profile.avatar')
        .populate('shop',    'name verificationStatus')
        .populate('category','name')
        .select('-rsvps -polls') // don't bloat list response
        .sort({ startsAt: 1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Event.countDocuments(filter),
    ]);

    const normalizedEvents = await Promise.all(events.map((event) => enrichResponseItem(event)));

    res.json({
      success: true,
      data: {
        events: normalizedEvents,
        pagination: {
          currentPage: page,
          totalPages:  Math.ceil(total / limit),
          total,
          limit,
        },
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * GET /api/v1/events/:id
 * Public — full event with polls. RSVPs excluded unless seller/admin.
 * View signal emitted.
 */
exports.getEventById = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id)
      .populate('seller',  'profile.firstName profile.lastName profile.avatar')
      .populate('shop',    'name verificationStatus')
      .populate('category','name');

    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    // Reveal virtual join URL only to confirmed attendees and the seller
    const userId   = req.user?._id?.toString();
    const isSeller = event.seller._id.toString() === userId;
    const isAdmin  = req.user?.userType === 'ADMIN';
    const isRsvpd  = event.rsvps.some(
      (r) => r.user.toString() === userId && r.status === 'confirmed'
    );

    const eventObj = event.toObject();

    if (!isSeller && !isAdmin && !isRsvpd) {
      // Hide join URL from non-attendees
      if (eventObj.virtual) eventObj.virtual.joinUrl = undefined;
    }

    // Exclude full RSVP list unless seller or admin
    if (!isSeller && !isAdmin) {
      delete eventObj.rsvps;
    }

    // Fire-and-forget view signal + counter
    if (userId) {
      fireSignal(() => emitEventViewSignal(event._id, userId, event.category?._id || event.category));
    }
    Event.findByIdAndUpdate(req.params.id, { $inc: { 'engagement.views': 1 } })
      .catch((e) => console.error('[Event view inc]', e.message));

    res.json({ success: true, data: { event: eventObj }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * PUT /api/v1/events/:id
 * Seller updates own event. Optionally replaces banner image.
 */
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && event.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    await parseImage(req, res);

    if (req.file) {
      // Delete old banner from Cloudinary
      if (event.banner?.publicId) {
        const { cloudinary } = require('../config/cloudinary');
        await cloudinary.uploader.destroy(event.banner.publicId).catch(() => {});
      }
      const url = await uploadToCloudinary(req.file, 'events');
      await deleteTempFile(req.file.path);
      event.banner = { url, publicId: req.file.filename };
    }

    const fields = ['title', 'description', 'type', 'startsAt', 'endsAt',
                    'isFree', 'category', 'status', 'maxAttendees', 'cancelledReason'];
    fields.forEach((f) => { if (req.body[f] !== undefined) event[f] = req.body[f]; });

    if (req.body.location)     event.location     = parseField(req.body.location, event.location);
    if (req.body.virtual)      event.virtual      = parseField(req.body.virtual, event.virtual);
    if (req.body.tags)         event.tags         = parseField(req.body.tags, event.tags);
    if (req.body.ticketTiers)  event.ticketTiers  = parseField(req.body.ticketTiers, event.ticketTiers);

    await event.save();
    res.json({ success: true, data: { event }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Delete ───────────────────────────────────────────────────────────────────

exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && event.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    if (event.banner?.publicId) {
      const { cloudinary } = require('../config/cloudinary');
      await cloudinary.uploader.destroy(event.banner.publicId).catch(() => {});
    }

    await Event.findByIdAndDelete(req.params.id);
    res.json({ success: true, data: { message: 'Event deleted' }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Cancel ───────────────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/events/:id/cancel
 * Soft cancel — keeps the document, sets status to 'cancelled'.
 */
exports.cancelEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && event.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    event.status           = 'cancelled';
    event.cancelledReason  = req.body.reason || '';
    await event.save();

    res.json({ success: true, data: { event }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── RSVP / Tickets ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/events/:id/rsvp
 * Buyer RSVPs to a free event or claims a ticket tier.
 * Body: { tierId } — omit for free RSVP
 * Auth required.
 */
exports.rsvp = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    if (event.status !== 'published') {
      return res.status(400).json({
        success: false,
        errors: ['This event is not accepting RSVPs'],
        data: null,
      });
    }

    if (new Date() > event.startsAt) {
      return res.status(400).json({
        success: false,
        errors: ['This event has already started'],
        data: null,
      });
    }

    const userId = req.user._id;

    // Check for existing RSVP
    const existing = event.rsvps.find(
      (r) => r.user.toString() === userId.toString() && r.status === 'confirmed'
    );
    if (existing) {
      return res.status(400).json({
        success: false,
        errors: ['You have already RSVPd to this event'],
        data: null,
      });
    }

    // Check overall capacity
    if (event.maxAttendees && event.rsvpCount >= event.maxAttendees) {
      return res.status(400).json({
        success: false,
        errors: ['This event is fully booked'],
        data: null,
      });
    }

    let tierId = null;
    let ticketCode = null;

    // Paid ticket tier claim
    if (!event.isFree && req.body.tierId) {
      const tier = event.ticketTiers.id(req.body.tierId);
      if (!tier) {
        return res.status(404).json({ success: false, errors: ['Ticket tier not found'], data: null });
      }
      if (tier.claimedSlots >= tier.totalSlots) {
        return res.status(400).json({ success: false, errors: [`${tier.name} tickets are sold out`], data: null });
      }
      tier.claimedSlots += 1;
      tierId     = tier._id;
      ticketCode = generateTicketCode();
    } else if (!event.isFree && !req.body.tierId) {
      return res.status(400).json({
        success: false,
        errors: ['Please select a ticket tier for this paid event'],
        data: null,
      });
    } else {
      // Free event RSVP gets a code too
      ticketCode = generateTicketCode();
    }

    event.rsvps.push({
      user:       userId,
      tierId,
      status:     'confirmed',
      ticketCode,
    });
    event.rsvpCount          += 1;
    event.engagement.rsvps   += 1;
    await event.save();

    // Emit engage signal
    fireSignal(() =>
      emitEventEngageSignal(event._id, userId, event.category?._id || event.category, 'rsvp')
    );

    res.status(201).json({
      success: true,
      data: {
        ticketCode,
        tierId,
        message: event.isFree ? 'RSVP confirmed!' : 'Ticket claimed!',
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * DELETE /api/v1/events/:id/rsvp
 * Cancel own RSVP — releases the ticket slot.
 */
exports.cancelRsvp = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    const userId = req.user._id.toString();
    const rsvp   = event.rsvps.find(
      (r) => r.user.toString() === userId && r.status === 'confirmed'
    );

    if (!rsvp) {
      return res.status(400).json({ success: false, errors: ['No active RSVP found'], data: null });
    }

    rsvp.status = 'cancelled';

    // Release ticket slot if paid
    if (rsvp.tierId) {
      const tier = event.ticketTiers.id(rsvp.tierId);
      if (tier) tier.claimedSlots = Math.max(0, tier.claimedSlots - 1);
    }

    event.rsvpCount        = Math.max(0, event.rsvpCount - 1);
    event.engagement.rsvps = Math.max(0, event.engagement.rsvps - 1);
    await event.save();

    res.json({ success: true, data: { message: 'RSVP cancelled' }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Polls ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/events/:id/polls
 * Seller creates a poll inside an event (can be created before or during the event).
 * Body: { question, options: ['Option A', 'Option B', ...] }
 */
exports.createPoll = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && event.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    const { question, options } = req.body;

    if (!question?.trim()) {
      return res.status(400).json({ success: false, errors: ['Question is required'], data: null });
    }
    if (!Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ success: false, errors: ['At least 2 options required'], data: null });
    }
    if (options.length > 10) {
      return res.status(400).json({ success: false, errors: ['Maximum 10 options allowed'], data: null });
    }

    const poll = {
      question: question.trim(),
      options:  options.map((o) => ({ text: o.toString().trim(), votes: 0, voters: [] })),
      status:   'active',
    };

    event.polls.push(poll);
    await event.save();

    const created = event.polls[event.polls.length - 1];
    res.status(201).json({ success: true, data: { poll: created }, errors: [] });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * POST /api/v1/events/:id/polls/:pollId/vote
 * Buyer casts a vote. One vote per user per poll — idempotent toggle.
 * Body: { optionId }
 * Auth required.
 */
exports.vote = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    const poll = event.polls.id(req.params.pollId);
    if (!poll) {
      return res.status(404).json({ success: false, errors: ['Poll not found'], data: null });
    }

    if (poll.status === 'closed') {
      return res.status(400).json({ success: false, errors: ['This poll is closed'], data: null });
    }

    const { optionId } = req.body;
    const option = poll.options.id(optionId);
    if (!option) {
      return res.status(404).json({ success: false, errors: ['Option not found'], data: null });
    }

    const userId     = req.user._id;
    const userIdStr  = userId.toString();

    // Find if user already voted on ANY option in this poll
    const previousOption = poll.options.find((o) =>
      o.voters.some((v) => v.toString() === userIdStr)
    );

    if (previousOption) {
      if (previousOption._id.toString() === optionId) {
        // Clicking same option = retract vote
        previousOption.voters.pull(userId);
        previousOption.votes = Math.max(0, previousOption.votes - 1);
        poll.totalVotes      = Math.max(0, poll.totalVotes - 1);
      } else {
        // Switch vote to new option
        previousOption.voters.pull(userId);
        previousOption.votes = Math.max(0, previousOption.votes - 1);
        option.voters.addToSet(userId);
        option.votes += 1;
        // totalVotes stays the same — just moved
      }
    } else {
      // First vote
      option.voters.addToSet(userId);
      option.votes    += 1;
      poll.totalVotes += 1;
    }

    await event.save();

    // Return poll results without voter lists (privacy)
    const results = poll.options.map((o) => ({
      _id:        o._id,
      text:       o.text,
      votes:      o.votes,
      percentage: poll.totalVotes > 0
        ? parseFloat(((o.votes / poll.totalVotes) * 100).toFixed(1))
        : 0,
    }));

    res.json({
      success: true,
      data: {
        pollId:     poll._id,
        totalVotes: poll.totalVotes,
        results,
        yourVote:   option._id,
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * PATCH /api/v1/events/:id/polls/:pollId/close
 * Seller closes a poll. Winner = option with most votes.
 * On tie, winner is the first tied option (first-mover advantage).
 */
exports.closePoll = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    if (req.user.userType !== 'ADMIN' && event.seller.toString() !== req.user.id) {
      return res.status(403).json({ success: false, errors: ['Not authorized'], data: null });
    }

    const poll = event.polls.id(req.params.pollId);
    if (!poll) {
      return res.status(404).json({ success: false, errors: ['Poll not found'], data: null });
    }

    if (poll.status === 'closed') {
      return res.json({ success: true, data: { poll }, errors: [] });
    }

    // Determine winner
    const winner = poll.options.reduce(
      (best, o) => (o.votes > best.votes ? o : best),
      poll.options[0]
    );

    poll.status         = 'closed';
    poll.closedAt       = new Date();
    poll.winnerOptionId = winner._id;

    await event.save();

    const results = poll.options.map((o) => ({
      _id:        o._id,
      text:       o.text,
      votes:      o.votes,
      percentage: poll.totalVotes > 0
        ? parseFloat(((o.votes / poll.totalVotes) * 100).toFixed(1))
        : 0,
      isWinner: o._id.toString() === winner._id.toString(),
    }));

    res.json({
      success: true,
      data: { pollId: poll._id, winner: { _id: winner._id, text: winner.text }, results },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

/**
 * GET /api/v1/events/:id/polls/:pollId
 * Public — get live poll results (voter lists stripped for privacy).
 */
exports.getPollResults = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).select('polls seller');
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    const poll = event.polls.id(req.params.pollId);
    if (!poll) {
      return res.status(404).json({ success: false, errors: ['Poll not found'], data: null });
    }

    const userId = req.user?._id?.toString();
    const yourVote = userId
      ? poll.options.find((o) => o.voters.some((v) => v.toString() === userId))?._id || null
      : null;

    const results = poll.options.map((o) => ({
      _id:        o._id,
      text:       o.text,
      votes:      o.votes,
      percentage: poll.totalVotes > 0
        ? parseFloat(((o.votes / poll.totalVotes) * 100).toFixed(1))
        : 0,
      isWinner: poll.status === 'closed'
        ? o._id.toString() === poll.winnerOptionId?.toString()
        : null,
    }));

    res.json({
      success: true,
      data: {
        poll: {
          _id:        poll._id,
          question:   poll.question,
          status:     poll.status,
          totalVotes: poll.totalVotes,
          closedAt:   poll.closedAt,
          results,
          yourVote,
        },
      },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

// ─── Like ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/events/:id/like
 */
exports.toggleLike = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, errors: ['Event not found'], data: null });
    }

    const userId   = req.user._id;
    const hasLiked = event.likes.some((id) => id.equals(userId));

    if (hasLiked) {
      await Event.findByIdAndUpdate(req.params.id, {
        $pull: { likes: userId },
        $inc:  { 'engagement.likes': -1 },
      });
    } else {
      await Event.findByIdAndUpdate(req.params.id, {
        $addToSet: { likes: userId },
        $inc:      { 'engagement.likes': 1 },
      });
      fireSignal(() =>
        emitEventEngageSignal(event._id, userId, event.category?._id || event.category, 'like')
      );
    }

    const updated = await Event.findById(req.params.id).select('engagement.likes');
    res.json({
      success: true,
      data: { liked: !hasLiked, likeCount: updated.engagement.likes },
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};