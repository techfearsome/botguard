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
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Workspace', WorkspaceSchema);
