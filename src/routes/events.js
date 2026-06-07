const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/eventController');
const auth = require('../middleware/auth');
const sellerOrAdmin = require('../middleware/sellerOrAdmin');

/**
 * @swagger
 * tags:
 *   name: Events
 *   description: Physical and virtual events with ticketing and live polls
 */

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/', ctrl.getAllEvents);
router.get('/:id', ctrl.getEventById);

// Poll results — public so non-attendees can see results after close
router.get('/:id/polls/:pollId', ctrl.getPollResults);

// ── Seller / Admin — event lifecycle ─────────────────────────────────────────
router.post('/', auth, sellerOrAdmin, ctrl.createEvent);
router.put('/:id', auth, sellerOrAdmin, ctrl.updateEvent);
router.patch('/:id/cancel', auth, ctrl.cancelEvent);
router.delete('/:id', auth, ctrl.deleteEvent);

// ── Polls — seller creates and closes, buyers vote ───────────────────────────
router.post('/:id/polls', auth, ctrl.createPoll);
router.post('/:id/polls/:pollId/vote', auth, ctrl.vote);
router.patch('/:id/polls/:pollId/close', auth, ctrl.closePoll);

// ── Attendee interactions ─────────────────────────────────────────────────────
router.post('/:id/rsvp', auth, ctrl.rsvp);
router.delete('/:id/rsvp', auth, ctrl.cancelRsvp);
router.post('/:id/like', auth, ctrl.toggleLike);

module.exports = router;