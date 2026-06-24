const express = require('express');
const router = express.Router();
const { User } = require('../models/User');
const { APPS } = require('../config/AppsConfig');

/**
 * GET /r/:code
 *
 * Same URL shape for everyone — https://swahilifamily.com/r/HEADXVS9 — but
 * now resolves to ONE of two apps depending on the REFERRER's userType,
 * since the product rule is "buyers invite buyers, sellers invite sellers."
 *
 * Flow:
 *  1. Look up the code -> find the referrer -> read their userType
 *  2. userType === 'SELLER' -> point at the seller app (com.swahilifamily.seller)
 *     otherwise -> point at the buyer app (com.headrick.swahili)
 *  3. Copy the code to clipboard, redirect to the correct Play Store listing
 *  4. If the code is invalid/unknown, fall back to a generic chooser page
 *     (can't know which app without a valid referrer) rather than guessing
 *
 * IMPORTANT — Android App Links verification:
 * Each app's intent filter can only claim paths it's actually verified for
 * via assetlinks.json. Since BOTH apps share this domain but serve
 * DIFFERENT audiences, assetlinks.json must list BOTH apps (see
 * mobile/UNIVERSAL_LINKS_SETUP.md) — Android will then offer whichever
 * app is installed, and if a user has BOTH apps installed, Android may
 * show a disambiguation dialog. That's expected and fine — it's the same
 * either way once the page below decides which STORE to send a non-app-
 * having user to.
 *
 * Mount this at /r — NOT under /api/v1 — same as before.
 */
router.get('/:code', async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();

  let referrer = null;
  if (code) {
    referrer = await User.findOne({ referralCode: code })
      .select('username profile.firstName userType')
      .catch(() => null);
  }

  // Unknown/invalid code — we genuinely don't know which app to point to.
  // Show a neutral chooser instead of guessing wrong.
  if (!referrer) {
    return res.send(renderChooserPage({ code }));
  }

  const targetApp = referrer.userType === 'SELLER' ? APPS.seller : APPS.buyer;
  const referrerName = referrer.profile?.firstName || referrer.username;

  res.setHeader('Content-Type', 'text/html');
  res.send(renderAppPage({ code, referrerName, targetApp }));
});

function renderAppPage({ code, referrerName, targetApp }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Join ${targetApp.displayName}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 40px 20px; color: #1a1a1a; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p { color: #555; font-size: 15px; }
    .code { font-size: 28px; font-weight: 700; letter-spacing: 2px; margin: 24px 0; color: #2d6cdf; }
    .btn { display: inline-block; margin-top: 24px; padding: 14px 32px; background: #2d6cdf; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; }
    .hint { margin-top: 16px; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <h1>${referrerName ? `${referrerName} invited you to ${targetApp.displayName}!` : `Join ${targetApp.displayName}!`}</h1>
  <p>Use this code when you sign up to get a welcome bonus:</p>
  <div class="code">${code}</div>
  <a class="btn" id="storeLink" href="${targetApp.playStoreUrl}">Get the App</a>
  <p class="hint">We've copied your invite code — just open the app after installing.</p>

  <script>
    (function () {
      var code = ${JSON.stringify(code)};
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).catch(function () {});
      }
      var btn = document.getElementById('storeLink');
      if (btn) {
        btn.addEventListener('click', function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code);
          }
        });
      }
    })();
  </script>
</body>
</html>
  `;
}

/**
 * Shown only when the code doesn't resolve to a real referrer (invalid,
 * typo'd, or expired-and-deleted user). We can't know buyer vs seller, so
 * offer both — this should be rare in practice since codes only ever
 * come from real shared links.
 */
function renderChooserPage({ code }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Swahili Family</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 40px 20px; color: #1a1a1a; }
    h1 { font-size: 20px; }
    .btn { display: block; margin: 16px auto; padding: 14px 32px; background: #2d6cdf; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; max-width: 240px; }
    .btn.secondary { background: #555; }
  </style>
</head>
<body>
  <h1>This invite link couldn't be verified, but you can still join:</h1>
  <a class="btn" href="${APPS.buyer.playStoreUrl}">I'm a Buyer</a>
  <a class="btn secondary" href="${APPS.seller.playStoreUrl}">I'm a Seller</a>
</body>
</html>
  `;
}

module.exports = router;