const { User } = require('../models/User');

// ─── App store links ──────────────────────────────────────────────────────────
// Fill in once apps are live. Until then these can stay as placeholders —
// the page still works, the buttons just won't go anywhere useful yet.
const STORE_LINKS = {
  buyer: {
    ios:     process.env.BUYER_APP_IOS_URL     || '#',
    android: process.env.BUYER_APP_ANDROID_URL || '#',
  },
  seller: {
    ios:     process.env.SELLER_APP_IOS_URL     || '#',
    android: process.env.SELLER_APP_ANDROID_URL || '#',
  },
};

// Custom URL scheme each app registers for deep linking.
// e.g. swahilifamilyseller://signup?ref=CODE
const APP_SCHEMES = {
  buyer:  process.env.BUYER_APP_SCHEME  || 'swahilifamily',
  seller: process.env.SELLER_APP_SCHEME || 'swahilifamilyseller',
};

/**
 * GET /r/:code
 *
 * Server-rendered landing page. In production, this route is only ever
 * actually hit by:
 *   - Desktop browsers (no mobile app to redirect to)
 *   - Mobile browsers where the app isn't installed and OS-level deep
 *     linking (Universal Links / App Links) wasn't configured or didn't
 *     intercept the request
 *
 * If the app IS installed and deep linking is configured correctly, the
 * OS intercepts this URL before it ever reaches your server — this route
 * is purely the fallback experience, not the primary path.
 */
exports.renderReferralLanding = async (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase();

    const referrer = await User.findOne({ referralCode: code }).select('userType username');

    if (!referrer) {
      return res.status(404).send(renderPage({
        title: 'Invalid Code',
        body: `<p>This referral link is invalid or has expired.</p>`,
      }));
    }

    const role = referrer.userType === 'SELLER' ? 'seller' : 'buyer';
    const userAgent = req.headers['user-agent'] || '';

    const platform = detectPlatform(userAgent);
    const deepLink = `${APP_SCHEMES[role]}://signup?ref=${code}`;
    const storeUrl = platform === 'ios' ? STORE_LINKS[role].ios : STORE_LINKS[role].android;

    res.send(renderLandingPage({ role, code, platform, deepLink, storeUrl, referrerName: referrer.username }));
  } catch (err) {
    res.status(500).send(renderPage({
      title: 'Something went wrong',
      body: `<p>Please try again later.</p>`,
    }));
  }
};

// ─── Platform detection ───────────────────────────────────────────────────────

const detectPlatform = (userAgent) => {
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/android/i.test(userAgent)) return 'android';
  return 'desktop';
};

// ─── HTML rendering ───────────────────────────────────────────────────────────
// Plain template strings — no view engine dependency, keeps this route
// self-contained. Inline styles since this is a single throwaway page,
// not part of your app's design system.

const renderPage = ({ title, body }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Swahili Family</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #f9fafb;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 32px; max-width: 380px;
            text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    h1 { font-size: 20px; color: #1f2937; margin-bottom: 12px; }
    p { color: #6b7280; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>`;

const renderLandingPage = ({ role, code, platform, deepLink, storeUrl, referrerName }) => {
  const roleLabel = role === 'seller' ? 'Seller' : 'Buyer';
  const appName = role === 'seller' ? 'Swahili Family Seller' : 'Swahili Family';

  const storeButton = platform === 'desktop'
    ? ''
    : `<a href="${storeUrl}" class="store-button">Get the App</a>`;

  const bothBadges = platform === 'desktop' ? `
    <div class="badges">
      <a href="${STORE_LINKS[role].ios}" class="badge">📱 iOS</a>
      <a href="${STORE_LINKS[role].android}" class="badge">🤖 Android</a>
    </div>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Join ${appName}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #f9fafb;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 32px; max-width: 380px;
            text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .logo { font-size: 32px; margin-bottom: 8px; }
    h1 { font-size: 20px; color: #1f2937; margin-bottom: 4px; }
    .subtitle { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
    .code-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px;
                padding: 16px; margin-bottom: 20px; }
    .code-label { font-size: 11px; color: #6b7280; text-transform: uppercase;
                  letter-spacing: 0.5px; margin-bottom: 4px; }
    .code-value { font-size: 24px; font-weight: bold; color: #1e40af; letter-spacing: 2px; }
    .store-button { display: inline-block; background: #1e40af; color: white;
                    padding: 14px 32px; border-radius: 10px; text-decoration: none;
                    font-weight: 600; font-size: 15px; margin-bottom: 12px; }
    .badges { display: flex; gap: 10px; justify-content: center; margin-bottom: 12px; }
    .badge { flex: 1; background: #f3f4f6; color: #1f2937; padding: 12px;
             border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 600; }
    .hint { font-size: 12px; color: #9ca3af; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🛍️</div>
    <h1>Join ${appName}</h1>
    <p class="subtitle">${referrerName} invited you as a ${roleLabel}</p>

    <div class="code-box">
      <div class="code-label">Your Referral Code</div>
      <div class="code-value">${code}</div>
    </div>

    ${storeButton}
    ${bothBadges}

    <p class="hint">
      Already have the app? <a href="${deepLink}">Tap here to open it</a>
      and enter code <strong>${code}</strong> during signup.
    </p>
  </div>

  <script>
    // Attempt the deep link automatically on mobile — if the app is
    // installed, this fires before the user even needs to tap anything.
    // Desktop visitors never see this attempted (no point, no app to open).
    if (${platform !== 'desktop'}) {
      window.location.href = "${deepLink}";
    }
  </script>
</body>
</html>`;
};