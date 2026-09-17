const mongoose = require('mongoose');

/**
 * A saved proxy for the stress-test tool. Stored per workspace so they can be
 * reused across runs. Credentials are stored as-is (admin-only tool); protocol
 * is http or socks5 — the runner supports both natively.
 */
const SavedProxySchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  name:      { type: String, required: true },        // human label, e.g. "iProyal US Res"
  protocol:  { type: String, enum: ['http', 'socks5'], default: 'http' },
  host:      { type: String, required: true },
  port:      { type: Number, required: true },
  username:  { type: String, default: '' },
  password:  { type: String, default: '' },
  country:   { type: String, default: '' },           // note only
  expect:    { type: String, enum: ['allow', 'block', 'unknown'], default: 'unknown' },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('SavedProxy', SavedProxySchema);
