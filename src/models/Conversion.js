const mongoose = require('mongoose');

const ConversionSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
  click_id: { type: String, required: true, index: true },

  ts: { type: Date, default: Date.now },
  value: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  source: { type: String, enum: ['pixel', 'postback', 'api'], default: 'pixel' },
  event_name: { type: String, default: 'lead' },  // 'lead', 'purchase', 'signup', etc.

  raw_payload: mongoose.Schema.Types.Mixed,
});

ConversionSchema.index({ workspace_id: 1, ts: -1 });

module.exports = mongoose.model('Conversion', ConversionSchema);
