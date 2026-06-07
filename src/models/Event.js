const mongoose = require('mongoose');

// ─── Poll sub-schema ──────────────────────────────────────────────────────────
const pollOptionSchema = new mongoose.Schema(
  {
    text:     { type: String, required: true, maxlength: 200, trim: true },
    votes:    { type: Number, default: 0, min: 0 },
    // Voter IDs — deduplication at DB level, no double-voting possible
    voters:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { _id: true }
);

const pollSchema = new mongoose.Schema(
  {
    question:   { type: String, required: true, maxlength: 500, trim: true },
    options:    { type: [pollOptionSchema], validate: [(v) => v.length >= 2 && v.length <= 10, 'Polls need 2–10 options'] },
    status:     { type: String, enum: ['active', 'closed'], default: 'active' },
    // Winner is set when poll is closed
    winnerOptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    closedAt:   { type: Date },
    totalVotes: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// ─── Ticket tier sub-schema ───────────────────────────────────────────────────
const ticketTierSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },   // e.g. "VIP", "General"
    price:       { type: Number, required: true, min: 0 },       // 0 = free tier
    currency:    { type: String, default: 'TZS' },
    totalSlots:  { type: Number, required: true, min: 1 },
    claimedSlots:{ type: Number, default: 0, min: 0 },
    description: { type: String, maxlength: 500 },
  },
  { _id: true }
);

ticketTierSchema.virtual('available').get(function () {
  return this.totalSlots - this.claimedSlots;
});

ticketTierSchema.virtual('isSoldOut').get(function () {
  return this.claimedSlots >= this.totalSlots;
});

// ─── RSVP sub-schema ─────────────────────────────────────────────────────────
const rsvpSchema = new mongoose.Schema(
  {
    user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tierId:     { type: mongoose.Schema.Types.ObjectId, default: null }, // null = free event RSVP
    status:     { type: String, enum: ['confirmed', 'waitlisted', 'cancelled'], default: 'confirmed' },
    ticketCode: { type: String },  // generated on claim
    checkedIn:  { type: Boolean, default: false },
    checkedInAt:{ type: Date },
  },
  { timestamps: true }
);

// ─── Main Event schema ────────────────────────────────────────────────────────
const eventSchema = new mongoose.Schema(
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
      maxlength: 5000,
      trim: true,
    },

    // physical | virtual | hybrid
    type: {
      type: String,
      enum: ['physical', 'virtual', 'hybrid'],
      required: true,
    },

    // Physical location — required when type is physical or hybrid
    location: {
      venue:    { type: String, trim: true },
      address:  { type: String, trim: true },
      city:     { type: String, trim: true },
      country:  { type: String, trim: true },
      coordinates: {
        lat: { type: Number },
        lng: { type: Number },
      },
    },

    // Virtual — required when type is virtual or hybrid
    virtual: {
      platform: { type: String, trim: true },  // "Zoom", "YouTube Live", etc.
      joinUrl:  { type: String, trim: true },  // revealed only to confirmed RSVPs
    },

    // Timing
    startsAt: { type: Date, required: true, index: true },
    endsAt:   { type: Date, required: true },

    // Media
    banner: {
      url:      { type: String },
      publicId: { type: String },
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      index: true,
    },

    tags: [{ type: String, lowercase: true, trim: true }],

    // Ticketing
    isFree: { type: Boolean, default: true },
    ticketTiers: [ticketTierSchema],  // empty array = free event

    // Attendees / RSVPs
    rsvps:        [rsvpSchema],
    rsvpCount:    { type: Number, default: 0, min: 0 },  // confirmed only
    maxAttendees: { type: Number, default: null },        // null = unlimited

    // Polls — multiple polls per event, created by seller during event
    polls: [pollSchema],

    // Likes
    likes:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Lifecycle
    status: {
      type: String,
      enum: ['draft', 'published', 'cancelled', 'completed'],
      default: 'draft',
      index: true,
    },
    cancelledReason: { type: String },

    // Engagement — for explore scoring
    engagement: {
      views:  { type: Number, default: 0, min: 0 },
      likes:  { type: Number, default: 0, min: 0 },
      rsvps:  { type: Number, default: 0, min: 0 },  // mirrors rsvpCount
    },

    _exploreScore: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
eventSchema.index({ _exploreScore: -1, _id: -1 });
eventSchema.index({ status: 1, startsAt: 1 });           // upcoming events query
eventSchema.index({ status: 1, _exploreScore: -1 });
eventSchema.index({ seller: 1, createdAt: -1 });

// ─── Virtuals ────────────────────────────────────────────────────────────────
eventSchema.virtual('isUpcoming').get(function () {
  return this.startsAt > new Date();
});

eventSchema.virtual('isPast').get(function () {
  return this.endsAt < new Date();
});

eventSchema.set('toJSON',   { virtuals: true });
eventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Event', eventSchema);