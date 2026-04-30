const mongoose = require('mongoose');

const ConversionSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
  click_id: { type: String, required: true, index: true },

  ts: { type: Date, default: Date.now },
  value: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  source: { type: String, enum: ['pixel', 'postback', 'api', 'auto'], default: 'pixel' },
  event_name: { type: String, default: 'lead' },  // 'lead', 'purchase', 'signup', etc.

  // Auto-detection metadata - populated only when source='auto'
  auto_detected: { type: Boolean, default: false, index: true },
  matched_term: { type: String },                  // which configured term matched ("Download", "Subscribe")
  matched_text: { type: String },                  // the actual button text the visitor clicked
  matched_element: { type: String },               // tag name + a couple identifiers for forensics
  page_url: { type: String },                      // where the click happened

  raw_payload: mongoose.Schema.Types.Mixed,
});

ConversionSchema.index({ workspace_id: 1, ts: -1 });

module.exports = mongoose.model('Conversion', ConversionSchema);
