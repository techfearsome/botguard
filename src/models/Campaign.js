const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'paused', 'archived'], default: 'active' },

  landing_page_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' },
  safe_page_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' },

  // Which profile to apply for scoring
  source_profile: {
    type: String,
    enum: ['email', 'paid_ads', 'organic', 'affiliate', 'mixed'],
    default: 'mixed',
  },

  filter_config: {
    threshold: { type: Number, default: 70, min: 0, max: 100 },
    mode: { type: String, enum: ['log_only', 'enforce'], default: 'log_only' },
    rule_overrides: { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  // Conversion tracking
  postback_url: String,
  conversion_pixel: String,

  // Optional cost & metadata
  notes: String,
  tags: [String],

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

CampaignSchema.index({ workspace_id: 1, slug: 1 }, { unique: true });
CampaignSchema.index({ workspace_id: 1, status: 1 });

CampaignSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('Campaign', CampaignSchema);
