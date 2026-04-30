const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  session_id: { type: String, required: true, unique: true },

  // Either fingerprint hash or cookie-based identifier
  fingerprint_hash: String,
  ip_hash: String,

  first_click_id: String,
  first_seen: { type: Date, default: Date.now },
  last_seen: { type: Date, default: Date.now },
  click_count: { type: Number, default: 1 },

  converted: { type: Boolean, default: false },
  converted_at: Date,
});

SessionSchema.index({ workspace_id: 1, last_seen: -1 });
SessionSchema.index({ fingerprint_hash: 1 });

module.exports = mongoose.model('Session', SessionSchema);
