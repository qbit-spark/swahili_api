const express = require('express');
const router = express.Router();
const referralController = require('../controllers/referralController');
const auth = require('../middleware/auth');

// PUBLIC — no auth. Used by the mobile app to check which app a code
// belongs to (buyer/seller) before deciding whether to apply it silently
// or prompt the user to get a different app. Must be public since this
// runs BEFORE the user has signed up/logged in.
router.get('/resolve/:code', referralController.resolveCode);
router.get('/my-code', auth, referralController.getMyCode);
router.get('/my-referrals', auth, referralController.getMyReferrals);
router.get('/stats', auth, referralController.getStats);
    
module.exports = router;