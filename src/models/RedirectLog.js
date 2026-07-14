const mongoose = require('mongoose');

/**
 * RedirectLog — the dedicated log for REDIRECT campaigns.
 *
 * A redirect campaign runs the identical filtering stack as a normal campaign;
 * the only difference is the clean-traffic branch. When a visitor passes every
 * configured check (Level 1 gates + Level 2 guard as applicable), instead of
 * rendering an offer page they are redirected to the campaign's declared URL,
 * and that event is recorded here.
 *
 * This is separate from the Click collection on purpose: redirect campaigns
 * don't do conversion tracking, and their operators want a clean "who got sent
 * where" log. (The Click is still written too, so filtering, live view, and
 * CIDR/ASN intelligence keep working uniformly — this is additive.)
 */
const RedirectLogSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, required: true },
  campaign_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true, required: true },
  click_id:     { type: String, index: true },

  ts: { type: Date, default: Date.now, index: true },

  ip:       { type: String, default: '' },
  ip_hash:  { type: String, default: '' },
  asn:      { type: Number, default: null },
  asn_org:  { type: String, default: '' },
  country:  { type: String, default: '' },

  device_class: { type: String, default: '' },
  user_agent:   { type: String, default: '' },

  // Which click-identifiers were present (gclid/msclid/fbclid…) — useful for
  // confirming the redirect carried the ad platform's tracking through.
  external_ids: { type: mongoose.Schema.Types.Mixed, default: {} },

  destination_url: { type: String, required: true },
  delay_ms:        { type: Number, default: 0 },

  // Decision context at the moment of redirect (should be an allow/pass).
  decision:        { type: String, default: 'allow' },
  decision_reason: { type: String, default: '' },
  score_total:     { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now },
});

RedirectLogSchema.index({ workspace_id: 1, campaign_id: 1, ts: -1 });
RedirectLogSchema.index({ workspace_id: 1, ts: -1 });

module.exports = mongoose.model('RedirectLog', RedirectLogSchema);
