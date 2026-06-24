const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/verificationController');
const auth = require('../middleware/auth');
const { isAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Verification
 *   description: Seller badge tiers — Blue, Green, Gold
 */

// ── Seller-facing ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/verification/status:
 *   get:
 *     tags: [Verification]
 *     summary: Get my verification status
 *     description: >
 *       Returns current tier, listing cap, explore score boost, live metrics,
 *       next tier requirements, and full application history.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Status returned
 */
router.get('/status', auth, ctrl.getMyStatus);

/**
 * @swagger
 * /api/v1/verification/apply:
 *   post:
 *     tags: [Verification]
 *     summary: Apply for the next tier
 *     description: >
 *       Submits an application for the next badge tier up from current.
 *       Must progress in order: none → blue → green → gold.
 *       Green requires a national_id document; Gold requires business_license.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               tier:
 *                 type: string
 *                 enum: [blue, green, gold]
 *               docType:
 *                 type: string
 *                 enum: [national_id, business_license]
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Application submitted
 *       400:
 *         description: Validation error (wrong tier order, missing docs, pending application exists)
 */
router.post('/apply', auth, ctrl.applyForTier);

// ── Admin-facing ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/verification/admin/queue:
 *   get:
 *     tags: [Verification]
 *     summary: Get pending application review queue
 *     description: Admin only. Returns all pending applications, oldest first.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Queue returned
 */
router.get('/admin/queue', auth, isAdmin, ctrl.getReviewQueue);

/**
 * @swagger
 * /api/v1/verification/admin/{recordId}:
 *   get:
 *     tags: [Verification]
 *     summary: Get a seller's full verification record
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: recordId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Record returned
 */
router.get('/admin/:recordId', auth, isAdmin, ctrl.getSellerRecord);

/**
 * @swagger
 * /api/v1/verification/admin/{recordId}/applications/{applicationId}/approve:
 *   patch:
 *     tags: [Verification]
 *     summary: Approve a pending application
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Badge granted
 */
router.patch('/admin/:recordId/applications/:applicationId/approve', auth, isAdmin, ctrl.approveApplication);

/**
 * @swagger
 * /api/v1/verification/admin/{recordId}/applications/{applicationId}/reject:
 *   patch:
 *     tags: [Verification]
 *     summary: Reject a pending application
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [notes]
 *             properties:
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Application rejected
 *       400:
 *         description: Missing rejection reason
 */
router.patch('/admin/:recordId/applications/:applicationId/reject', auth, isAdmin, ctrl.rejectApplication);

/**
 * @swagger
 * /api/v1/verification/admin/{recordId}/revoke:
 *   patch:
 *     tags: [Verification]
 *     summary: Manually revoke a seller's badge
 *     description: For fraud or policy violations — separate from the automatic nightly sweep.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string }
 *               toTier:
 *                 type: string
 *                 enum: [none, blue, green]
 *     responses:
 *       200:
 *         description: Badge revoked
 */
router.patch('/admin/:recordId/revoke', auth, isAdmin, ctrl.manualRevoke);

module.exports = router;