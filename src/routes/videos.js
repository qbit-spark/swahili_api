const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/videoController');
const auth = require('../middleware/auth');
const sellerOrAdmin = require('../middleware/sellerOrAdmin');

/**
 * @swagger
 * tags:
 *   name: Videos
 *   description: Seller short-form video content
 */

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/', ctrl.getAllVideos);
router.get('/:id', ctrl.getVideoById);

// ── Seller / Admin ────────────────────────────────────────────────────────────
router.post('/', auth, sellerOrAdmin, ctrl.createVideo);
router.patch('/:id/publish', auth, ctrl.publishVideo);
router.put('/:id', auth, sellerOrAdmin, ctrl.updateVideo);
router.delete('/:id', auth, ctrl.deleteVideo);

// ── Buyer interactions ────────────────────────────────────────────────────────
router.post('/:id/like', auth, ctrl.toggleLike);
router.post('/:id/completion', auth, ctrl.reportCompletion);

module.exports = router;