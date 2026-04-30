const mongoose = require('mongoose');

/**
 * SitePage - workspace-wide static HTML pages served at top-level paths.
 *
 * Used so the root domain isn't a dead end (or worse, redirecting to the admin login).
 * When a campaign points to bg.example.com/go/foo, the bare domain bg.example.com/ would
 * otherwise just bounce to /admin/login. Now it can serve a real homepage, with /privacy
 * and /terms as additional pages required for ad platform compliance.
 *
 * Pages are identified by `slug`. Three slugs have special routing:
 *   - 'home'    → served at /
 *   - 'privacy' → served at /privacy
 *   - 'terms'   → served at /terms
 *
 * Other slugs are reachable at /p/<slug> for arbitrary site pages
 * (e.g. /p/about, /p/contact, /p/cookies).
 */
const SitePageSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  title: { type: String, default: '' },
  html: { type: String, default: '' },
  enabled: { type: Boolean, default: true },
  meta: {
    description: String,
    og_image: String,
    noindex: { type: Boolean, default: false },
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

SitePageSchema.index({ workspace_id: 1, slug: 1 }, { unique: true });

SitePageSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('SitePage', SitePageSchema);
