const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/amaController');
const auth = require('../middleware/auth');
const sellerOrAdmin = require('../middleware/sellerOrAdmin');

/**
 * @swagger
 * tags:
 *   name: AMAs
 *   description: Ask Me Anything sessions — seller hosted, buyer participated
 */

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/', ctrl.getAllAMAs);
router.get('/:id', ctrl.getAMAById);

// ── Seller / Admin — AMA lifecycle ────────────────────────────────────────────
router.post('/', auth, sellerOrAdmin, ctrl.createAMA);
router.put('/:id', auth, sellerOrAdmin, ctrl.updateAMA);
router.patch('/:id/open', auth, ctrl.openAMA);
router.patch('/:id/close', auth, ctrl.closeAMA);
router.delete('/:id', auth, ctrl.deleteAMA);

// ── Questions — buyer submits, seller answers ─────────────────────────────────
router.post('/:id/questions', auth, ctrl.submitQuestion);
router.patch('/:id/questions/:questionId/answer', auth, ctrl.answerQuestion);
router.patch('/:id/questions/:questionId/pin', auth, ctrl.pinQuestion);

// ── Interactions ──────────────────────────────────────────────────────────────
router.post('/:id/like', auth, ctrl.toggleLike);
router.post('/:id/questions/:questionId/upvote', auth, ctrl.upvoteQuestion);

module.exports = router;