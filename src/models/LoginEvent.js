const mongoose = require('mongoose');

/**
 * LoginEvent — a record of an admin login attempt (success or failure), for the
 * Security page. Stores who, when, from where (real client IP, Cloudflare-aware)
 * and device details, so brute-force attempts and logins from unexpected
 * IPs/countries are visible.
 *
 * Self-cleans after 90 days via a TTL index so the collection can't grow
 * unbounded.
 */
const LoginEventSchema = new mongoose.Schema({
  username: { type: String, default: '' },       // the username that was attempted
  success: { type: Boolean, default: false, index: true },
  reason: { type: String, default: '' },          // ok | bad_password | unknown_user | no_credentials

  ip: { type: String, default: '' },
  ip_hash: { type: String, default: '' },

  user_agent: { type: String, default: '' },
  device_class: { type: String, default: '' },    // windows/mac/iphone/android/...
  device_label: { type: String, default: '' },    // human-readable
  browser: { type: String, default: '' },
  os: { type: String, default: '' },

  created_at: { type: Date, default: Date.now, index: true },
});

// TTL: drop events older than 90 days automatically.
LoginEventSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
LoginEventSchema.index({ success: 1, created_at: -1 });

module.exports = mongoose.model('LoginEvent', LoginEventSchema);
