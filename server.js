require('dotenv').config();
require("./instruments");
require('./src/workers/referralWorker');
require('./src/workers/exploreWorker');
require('./src/workers/verificationWorker')
require('./src/workers/searchSyncWorker')
const Sentry = require("@sentry/node");
const express = require('express');
const connectDB = require('./src/config/db');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { requestLogger } = require('./src/middleware/logger');
const errorHandler = require('./src/middleware/errorHandler');
const paginateResults = require('./src/middleware/pagination');
const { apiLimiter } = require('./src/middleware/rateLimiter');
const securityMiddleware = require('./src/middleware/security');
const webhookRoutes = require('./src/routes/webhooks')
const swagger = require('./src/config/swagger');
const app = express();
const WishlistReminderService = require('./src/services/wishlistReminderService');
const { configureProductsIndex } = require('./src/config/meilisearch');
const { searchSyncQueue, triggerFullReindex } = require('./src/queues/searchSyncQueue');


/**
 * Schedules recurring background jobs that should persist across server
 * restarts. BullMQ's `repeat` option with a fixed `jobId` is idempotent —
 * calling .add() again on every boot does NOT create duplicate repeating
 * jobs, it just confirms/updates the existing schedule. Safe to call here
 * every time the server starts.
 */
async function scheduleRecurringJobs() {
    // Nightly full reindex — safety net for any drift between MongoDB and
    // Meilisearch (e.g. a sync job that failed silently, manual DB edits).
    await searchSyncQueue.add(
        'reindex:full',
        {},
        {
            jobId: 'nightly-full-reindex', // colon-free, see JOBID_FIX
            repeat: { pattern: '0 3 * * *' }, // 3am daily, server timezone
        }
    );

    console.log('[Bootstrap] Recurring jobs scheduled (nightly search reindex)');
}

// Initialize database and services
async function initializeApp() {
    try {
        await connectDB();
        // console.log('Database connected successfully');

        const initSearch = async () => {
            await configureProductsIndex();   // idempotent, safe every boot

            // Only auto-trigger a full reindex in production. In dev,
            // nodemon restarts constantly — queuing a full reindex of the
            // entire catalogue on every file save is wasteful and noisy.
            // The nightly cron job below + the manual fixSearchIndex.js
            // script cover dev/testing needs without the auto-trigger.
            if (process.env.NODE_ENV === 'production') {
                await triggerFullReindex();
            } else {
                console.log('[SearchSync] Dev mode — skipping auto full-reindex on boot.');
                console.log('[SearchSync] Run manually if needed: node src/scripts/fixSearchIndex.js');
            }
        };
        await initSearch();

        await scheduleRecurringJobs();

        await WishlistReminderService.sendWishlistReminders();
        // console.log('Wishlist reminders sent successfully');
    } catch (error) {
        console.error('Initialization error:', error);
        process.exit(1);
    }
}

// Call initialization
initializeApp().catch(console.error);

// Init Middleware
// app.use(express.json({ extended: false }));
app.use(helmet()); // Security headers
app.use(cors());
app.use(compression()); // Compress responses
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger); // Request logging
app.use(paginateResults);
app.use(securityMiddleware);
app.set('trust proxy', 1); // Trust first proxy for rate limiting and secure cookies

app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        console.log(
            `${req.method} ${req.path}`,
            '→', res.statusCode,
            body.success === false ? `❌ ${JSON.stringify(body.errors)}` : '✅'
        );
        return originalJson(body);
    };
    next();
});

app.use('/api-docs', swagger.serve, swagger.setup);
app.use('/api/v1/', apiLimiter);

// Routes
app.use('/api/v1/auth', require('./src/routes/auth'));
app.use('/api/v1/products', require('./src/routes/products'));
app.use('/api/v1/categories', require('./src/routes/categories'));
app.use('/api/v1/shops', require('./src/routes/shops'));
app.use('/api/v1/upload', require('./src/routes/upload'));
app.use('/api/v1/health', require('./src/routes/health'));
app.use('/api/v1/users', require('./src/routes/userManagement'));
app.use('/api/v1/orders', require('./src/routes/orders'));
app.use('/api/v1/ratings', require('./src/routes/ratings'));
app.use('/api/v1/chat', require('./src/routes/chat'));
app.use('/api/v1/notifications', require('./src/routes/notifications'));
// app.use('/api/v1/webhooks', webhookRoutes)
app.use('/api/v1/profile', require('./src/routes/profile'));
app.use('/api/v1/account', require('./src/routes/account'));
app.use('/api/v1/wishlist', require('./src/routes/wishlist'));
app.use('/api/v1/announcements', require('./src/routes/announcements'));
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/withdrawals', require('./src/routes/withdrawals'));
app.use('/api/v1/posts', require('./src/routes/posts'));
app.use('/api/v1/videos', require('./src/routes/videos'));
app.use('/api/v1/amas', require('./src/routes/amas'));
app.use('/api/v1/explore', require('./src/routes/explore'));
app.use('/api/v1/events', require('./src/routes/events'));
app.use('/api/v1/referrals', require('./src/routes/referrals'));
app.use('/api/v1/verification', require('./src/routes/verification'));
app.use('/api/v1/search', require('./src/routes/search'));
app.get('/p/:id', require('./src/controllers/productController').getProductSharePage);
app.get('/r/:code', require('./src/controllers/referralLandingController').renderReferralLanding);
Sentry.setupExpressErrorHandler(app);


// Error handling
app.use(errorHandler);

// Serve Swagger JSON
app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=swagger.json');
    res.send(swagger.swaggerSpec);
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        data: null,
        errors: ['Route not found']
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
    // In production i hafta crash the process
    // process.exit(1);
});


module.exports = app