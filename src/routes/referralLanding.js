const express = require('express');
const router = express.Router();
const { renderReferralLanding } = require('../controllers/referralLandingController');

// PUBLIC — no auth, no /api/v1 prefix. This is a human-facing browser
// route, not a JSON API endpoint, so it's mounted directly at the app
// root (see server.js: app.get('/r/:code', ...) style mount, same
// pattern as your existing app.get('/p/:id', ...) product share page).
router.get('/:code', renderReferralLanding);

module.exports = router;