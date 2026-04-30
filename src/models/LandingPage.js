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

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

LandingPageSchema.index({ workspace_id: 1, slug: 1 }, { unique: true });

LandingPageSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('LandingPage', LandingPageSchema);
