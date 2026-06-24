const {
    SellerVerification, TIERS, TIER_ORDER, TIER_REQUIREMENTS,
} = require('../models/SellerVerification');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Shop = require('../models/Shop');
const { uploadToCloudinary, deleteTempFile, cloudinary } = require('../config/cloudinary');
const { parseImage } = require('../middleware/multer');
const { isAllowlistedForTier } = require('../config/verificationAllowlist');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const computeMetrics = async (sellerId, shopId) => {
    const [totalProducts, orderAgg] = await Promise.all([
        Product.countDocuments({ shop: shopId }),
        Order.aggregate([
            { $match: { shop: shopId, status: 'completed' } },
            { $group: { _id: null, count: { $sum: 1 }, avgRating: { $avg: '$rating' } } },
        ]),
    ]);

    return {
        totalProducts,
        totalOrders: orderAgg[0]?.count ?? 0,
        avgRating: parseFloat((orderAgg[0]?.avgRating ?? 0).toFixed(2)),
        lastComputedAt: new Date(),
    };
};

const getNextTier = (currentTier) => {
    const idx = TIER_ORDER.indexOf(currentTier);
    return idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : null;
};

const findOrCreateRecord = async (sellerId, shopId) => {
    let record = await SellerVerification.findOne({ seller: sellerId });
    if (!record) {
        record = await SellerVerification.create({ seller: sellerId, shop: shopId });
    }
    return record;
};

/**
 * Syncs the approved tier onto the Shop document so /shops/own and every
 * other shop-populating endpoint can surface the badge without an extra
 * query or a join into SellerVerification.
 */
const syncTierToShop = async (shopId, tier) => {
    await Shop.findByIdAndUpdate(shopId, { verificationTier: tier });
};

exports.getMyStatus = async (req, res) => {
    try {
        const shop = await Shop.findOne({ owner: req.user.id });
        if (!shop) {
            return res.status(400).json({ success: false, errors: ['No shop found'], data: null });
        }

        const record = await findOrCreateRecord(req.user.id, shop._id);
        const nextTier = getNextTier(record.currentTier);

        const liveMetrics = await computeMetrics(req.user.id, shop._id);
        record.metrics = liveMetrics;
        await record.save();

        const pendingApp = nextTier ? record.getPendingApplication(nextTier) : null;

        res.json({
            success: true,
            data: {
                currentTier: record.currentTier,
                listingCap: record.getListingCap(),
                exploreBoost: record.getExploreBoost(),
                metrics: record.metrics,
                nextTier: nextTier,
                nextTierRequirements: nextTier ? TIER_REQUIREMENTS[nextTier] : null,
                meetsNextTierRequirements: nextTier ? record.meetsRequirements(nextTier) : null,
                pendingApplication: pendingApp ? {
                    tier: pendingApp.tier,
                    submittedAt: pendingApp.createdAt,
                    status: pendingApp.status,
                } : null,
                applicationHistory: record.applications.map((a) => ({
                    tier: a.tier,
                    status: a.status,
                    submittedAt: a.createdAt,
                    reviewedAt: a.reviewedAt,
                    reviewNotes: a.reviewNotes,
                })),
            },
            errors: [],
        });
    } catch (err) {
        res.status(500).json({ success: false, data: null, errors: [err.message] });
    }
};


/**
 * Submit an application for a tier. Multipart — document uploaded as a file.
 *
 * Allowlisted accounts (config/verificationAllowlist.js) skip document
 * requirements and skip the pending-review step entirely — the application
 * is created and immediately marked approved, badge granted in the same call.
 * Everyone else goes through the normal pending → admin review flow.
 */
exports.applyForTier = async (req, res) => {
    try {
        await parseImage(req, res);

        const { tier, docType } = req.body;

        if (!Object.values(TIERS).includes(tier) || tier === TIERS.NONE) {
            return res.status(400).json({ success: false, errors: ['Invalid tier'], data: null });
        }

        const shop = await Shop.findOne({ owner: req.user.id });
        if (!shop) {
            return res.status(400).json({ success: false, errors: ['No shop found'], data: null });
        }

        const record = await findOrCreateRecord(req.user.id, shop._id);

        if (record.getPendingApplication(tier)) {
            return res.status(400).json({
                success: false,
                errors: ['You already have a pending application for this tier'],
                data: null,
            });
        }

        const currentIdx = TIER_ORDER.indexOf(record.currentTier);
        const targetIdx = TIER_ORDER.indexOf(tier);
        if (targetIdx <= currentIdx) {
            return res.status(400).json({
                success: false,
                errors: [`You already hold the ${tier} badge or higher`],
                data: null,
            });
        }

        const isAllowlisted = isAllowlistedForTier(req.user.id, tier);

        // Allowlisted accounts can skip directly to any tier they're cleared for —
        // normal sellers must progress one tier at a time.
        if (!isAllowlisted && targetIdx !== currentIdx + 1) {
            return res.status(400).json({
                success: false,
                errors: [`You must be ${TIER_ORDER[currentIdx + 1]} before applying for ${tier}`],
                data: null,
            });
        }

        const requiredDocs = TIER_REQUIREMENTS[tier].requiredDocs;

        // Allowlisted accounts skip the document requirement entirely
        if (!isAllowlisted && requiredDocs.length > 0 && !req.file) {
            return res.status(400).json({
                success: false,
                errors: [`This tier requires a ${requiredDocs.join(', ')} document upload`],
                data: null,
            });
        }

        let documents = [];
        if (req.file) {
            const url = await uploadToCloudinary(req.file, 'verification-docs');
            await deleteTempFile(req.file.path);
            const publicId = url.split('/').slice(-2).join('/').replace(/\.[^/.]+$/, '');
            documents = [{
                type: docType || requiredDocs[0] || 'other',
                url,
                publicId,
            }];
        }

        const metricsSnapshot = await computeMetrics(req.user.id, shop._id);
        record.metrics = metricsSnapshot;

        const newApplication = {
            tier,
            status: isAllowlisted ? 'approved' : 'pending',
            documents,
            metricsSnapshot: {
                totalProducts: metricsSnapshot.totalProducts,
                totalOrders: metricsSnapshot.totalOrders,
                avgRating: metricsSnapshot.avgRating,
            },
        };

        if (isAllowlisted) {
            newApplication.reviewedAt = new Date();
            newApplication.reviewNotes = 'Auto-approved via verification allowlist';
        }

        record.applications.push(newApplication);

        // Allowlisted accounts get the badge immediately, same call
        if (isAllowlisted) {
            record.currentTier = tier;
            record.tierGrantedAt = new Date();
            record.belowThresholdSince = null;
        }

        await record.save();

        // Keep Shop.verificationTier in sync whenever the tier actually changes
        if (isAllowlisted) {
            await syncTierToShop(shop._id, tier);
        }

        res.status(201).json({
            success: true,
            data: {
                message: isAllowlisted
                    ? `${tier} badge granted instantly (allowlisted account)`
                    : 'Application submitted for review',
                tier,
                status: isAllowlisted ? 'approved' : 'pending',
                metricsSnapshot,
            },
            errors: [],
        });
    } catch (err) {
        res.status(500).json({ success: false, data: null, errors: [err.message] });
    }
};

// ─── Admin endpoints ──────────────────────────────────────────────────────────

exports.getReviewQueue = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(40, parseInt(req.query.limit) || 20);

        const records = await SellerVerification.find({ 'applications.status': 'pending' })
            .populate('seller', 'username email profile.firstName profile.lastName')
            .populate('shop', 'name')
            .lean();

        const queue = [];
        for (const record of records) {
            for (const app of record.applications) {
                if (app.status === 'pending') {
                    queue.push({
                        recordId: record._id,
                        applicationId: app._id,
                        seller: record.seller,
                        shop: record.shop,
                        currentTier: record.currentTier,
                        tier: app.tier,
                        documents: app.documents,
                        metricsSnapshot: app.metricsSnapshot,
                        submittedAt: app.createdAt,
                    });
                }
            }
        }
        queue.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));

        const skip = (page - 1) * limit;
        const total = queue.length;

        res.json({
            success: true,
            data: {
                queue: queue.slice(skip, skip + limit),
                pagination: { currentPage: page, totalPages: Math.ceil(total / limit), total, limit },
            },
            errors: [],
        });
    } catch (err) {
        res.status(500).json({ success: false, data: null, errors: [err.message] });
    }
};

exports.approveApplication = async (req, res) => {
    try {
        const record = await SellerVerification.findById(req.params.recordId);
        if (!record) {
            return res.status(404).json({ success: false, errors: ['Record not found'], data: null });
        }

        const app = record.applications.id(req.params.applicationId);
        if (!app || app.status !== 'pending') {
            return res.status(404).json({ success: false, errors: ['Pending application not found'], data: null });
        }

        app.status = 'approved';
        app.reviewedBy = req.user.id;
        app.reviewedAt = new Date();
        app.reviewNotes = req.body.notes || '';

        record.currentTier = app.tier;
        record.tierGrantedAt = new Date();
        record.belowThresholdSince = null;

        await record.save();
        await syncTierToShop(record.shop, record.currentTier);

        res.json({
            success: true,
            data: { message: `${app.tier} badge granted`, currentTier: record.currentTier },
            errors: [],
        });
    } catch (err) {
        res.status(500).json({ success: false, data: null, errors: [err.message] });
    }
};

exports.rejectApplication = async (req, res) => {
    try {
        const { notes } = req.body;
        if (!notes?.trim()) {
            return res.status(400).json({ success: false, errors: ['Rejection reason is required'], data: null });
        }

        const record = await SellerVerification.findById(req.params.recordId);
        if (!record) {
            return res.status(404).json({ success: false, errors: ['Record not found'], data: null });
        }

        const app = record.applications.id(req.params.applicationId);
        if (!app || app.status !== 'pending') {
            return res.status(404).json({ success: false, errors: ['Pending application not found'], data: null });
        }

        app.status = 'rejected';
        app.reviewedBy = req.user.id;
        app.reviewedAt = new Date();
        app.reviewNotes = notes.trim();

        await record.save();

        res.json({
            success: true,
            data: { message: 'Application rejected', reason: notes },
            errors: [],
        });
    } catch (err) {
        res.status(500).json({ success: false, data: null, errors: [err.message] });
    }
};

exports.getSellerRecord = async (req, res) => {
    try {
        const record = await SellerVerification.findById(req.params.recordId)
            .populate('seller', 'username email profile')
            .populate('shop', 'name')
            .populate('applications.reviewedBy', 'username');

        if (!record) {
            return res.status(404).json({ success: false, errors: ['Record not found'], data: null });
        }

        res.json({ success: true, data: { record }, errors: [] });
    } catch (err) {
        res.status(500).json({ success: false, data: null, errors: [err.message] });
    }
};

exports.manualRevoke = async (req, res) => {
    try {
        const { reason, toTier } = req.body;
        if (!reason?.trim()) {
            return res.status(400).json({ success: false, errors: ['Revocation reason is required'], data: null });
        }

        const record = await SellerVerification.findById(req.params.recordId);
        if (!record) {
            return res.status(404).json({ success: false, errors: ['Record not found'], data: null });
        }

        const fromTier = record.currentTier;
        const newTier = toTier && TIER_ORDER.includes(toTier) ? toTier : TIERS.NONE;

        record.revocations.push({
            fromTier,
            toTier: newTier,
            reason: reason.trim(),
            automatic: false,
        });
        record.currentTier = newTier;
        record.belowThresholdSince = null;

        await record.save();
        await syncTierToShop(record.shop, newTier);

        res.json({
            success: true,
            data: { message: `Badge revoked: ${fromTier} → ${newTier}` },
            errors: [],
        });
    } catch (err) {
        res.status(500).json({ success: false, data: null, errors: [err.message] });
    }
};

exports.computeMetrics = computeMetrics;
exports.findOrCreateRecord = findOrCreateRecord;
exports.syncTierToShop = syncTierToShop;