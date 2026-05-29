const mongoose = require('mongoose');

const WorkspaceSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  owner_email: { type: String },
  api_keys: [{
    key: String,
    label: String,
    created_at: { type: Date, default: Date.now },
    last_used_at: Date,
  }],
  settings: {
    default_threshold: { type: Number, default: 70 },
    default_mode: { type: String, enum: ['log_only', 'enforce'], default: 'log_only' },

    // Admin UI theme preference. 'dark' (default) or 'light'.
    // Persisted per-workspace so admins get a consistent appearance across
    // browsers and devices. Read by views/partials/header.ejs to set the
    // data-theme attribute on <html> for first-paint correctness.
    theme: { type: String, enum: ['dark', 'light'], default: 'dark' },

    // Whether to block AI/training crawlers via robots.txt. Default false
    // (allow them). When true, robots.txt emits Disallow: / for known AI
    // crawler user-agents (GPTBot, ClaudeBot, Google-Extended, etc).
    // Note: only well-behaved crawlers respect robots.txt - this is opt-in
    // signaling, not enforcement. For real blocking, use the existing
    // proxy/ASN gates which run on every request.
    block_ai_crawlers: { type: Boolean, default: false },

    // Third-party analytics injection - applied to all offer + safe pages.
    // Useful for session replay (Clarity), error tracking, and ad-platform pixels.
    tracking: {
      // Microsoft Clarity project ID (e.g. "wjsr5hjt53"). Empty = no Clarity.
      // Validated to alphanumeric only at save time so we can't be tricked into
      // injecting arbitrary JS by setting an exotic value.
      clarity_project_id: { type: String, default: '' },
    },

    // Cloudflare edge firewall settings
    cloudflare_settings: {
      enabled: { type: Boolean, default: false },
      scan_mode: { type: String, enum: ['all', 'utm'], default: 'utm' },
      // Worker deployment state
      worker_deployed: { type: Boolean, default: false },
      worker_name: { type: String, default: '' },
      worker_zone_id: { type: String, default: '' },
      worker_route_id: { type: String, default: '' },
      worker_domain: { type: String, default: '' },
      last_deployed_at: { type: Date },
      deploy_error: { type: String, default: '' },
    },

    // Intelligence auto-export to Cloudflare
    intelligence_auto_cf: {
      enabled:    { type: Boolean, default: false },
      min_score:  { type: Number, default: 60 },     // minimum score to auto-export
      min_days:   { type: Number, default: 2 },       // minimum days seen
      min_hits:   { type: Number, default: 5 },       // minimum hit count
      auto_sync:  { type: Boolean, default: true },    // auto push to KV after adding
      last_run_at: { type: Date },
      last_exported_count: { type: Number, default: 0 },
    },
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Workspace', WorkspaceSchema);
