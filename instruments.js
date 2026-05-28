const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://a45f353347cf2759cee503da296749c4@o4507300060200960.ingest.de.sentry.io/4511466903699537",
  tracesSampleRate: 1.0, // Capture 100% of transactions (adjust for production)
  sendDefaultPii: true,
});