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

    // Third-party analytics injection - applied to all offer + safe pages.
    // Useful for session replay (Clarity), error tracking, and ad-platform pixels.
    tracking: {
      // Microsoft Clarity project ID (e.g. "wjsr5hjt53"). Empty = no Clarity.
      // Validated to alphanumeric only at save time so we can't be tricked into
      // injecting arbitrary JS by setting an exotic value.
      clarity_project_id: { type: String, default: '' },
    },
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Workspace', WorkspaceSchema);
