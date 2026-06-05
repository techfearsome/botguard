// Re-export from uaParser module — keeps existing imports working
const { detectInAppManual: detectInAppBrowser } = require('./uaParser/inapp');
module.exports = { detectInAppBrowser };
