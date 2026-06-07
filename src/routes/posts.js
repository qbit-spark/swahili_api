const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/postController');
const auth = require('../middleware/auth');
const sellerOrAdmin = require('../middleware/sellerOrAdmin');

/**
 * @swagger
 * tags:
 *   name: Posts
 *   description: Seller posts — image + caption content
 */

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/', ctrl.getAllPosts);
router.get('/:id', ctrl.getPostById);

// ── Seller / Admin ────────────────────────────────────────────────────────────
// multipart/form-data — Content-Type must be set by client (don't set manually)
router.post('/', auth, sellerOrAdmin, ctrl.createPost);
router.put('/:id', auth, sellerOrAdmin, ctrl.updatePost);
router.delete('/:id', auth, ctrl.deletePost);  // own post or admin

// ── Buyer interactions ────────────────────────────────────────────────────────
router.post('/:id/like', auth, ctrl.toggleLike);

module.exports = router;