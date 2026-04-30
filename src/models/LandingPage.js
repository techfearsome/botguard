const mongoose = require('mongoose');

const VariantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  weight: { type: Number, default: 1, min: 0 },
  html: { type: String, required: true },
}, { _id: false });

const LandingPageSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  kind: { type: String, enum: ['offer', 'safe'], default: 'offer' },

  // Single template OR variants for A/B testing
  html_template: { type: String, default: '' },
  variants: { type: [VariantSchema], default: [] },

  meta: {
    title: String,
    description: String,
    og_image: String,
  },

  // Auto-conversion tracking: when enabled, /go injects a JS snippet that fires a
  // conversion when the visitor clicks an element whose text matches one of the terms.
  // Terms are case-insensitive substring matches. Empty list = use the global defaults.
  auto_conversion: {
    enabled: { type: Boolean, default: false },
    terms: { type: [String], default: [] },
    // What to record on the Conversion document. Useful when the offer pays per type
    // (e.g. install, signup, purchase) and you want to discriminate without extra setup.
    event_name: { type: String, default: 'auto_click' },
  },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

LandingPageSchema.index({ workspace_id: 1, slug: 1 }, { unique: true });

LandingPageSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('LandingPage', LandingPageSchema);
