const mongoose = require('mongoose');

/**
 * SyncStagedEntry — a single CIDR or ASN pulled from an import partner, held in
 * a staging area separate from live firewall data. The importer decides what
 * happens to it. Nothing here affects traffic until state === 'implemented'
 * AND it was written into CidrIntelligence/AsnBlacklist by the import engine.
 *
 * match_status is the "have I seen this myself?" evidence that lets a
 * monitor/quarantine importer judge whether a partner's list is worth trusting:
 *   new       — we have no local record of this range/ASN
 *   match     — we've independently seen it (local_score / local_hits populated)
 *   duplicate — it's already in our ACTIVE data; nothing to do, skipped
 */
const SyncStagedEntrySchema = new mongoose.Schema({
  workspace_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, required: true },
  source_partner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SyncPartner', index: true, required: true },
  source_name:       { type: String, default: '' },   // denormalized for display

  kind:  { type: String, enum: ['cidr', 'asn'], required: true },
  value: { type: String, required: true },            // cidr string, or ASN as string

  // Metadata the partner shared (may be sparse)
  asn_org:      { type: String, default: '' },
  country:      { type: String, default: '' },
  remote_score: { type: Number, default: 0 },
  remote_label: { type: String, default: '' },        // high/medium/low/''

  // Local overlap evidence
  match_status: { type: String, enum: ['new', 'match', 'duplicate'], default: 'new', index: true },
  local_score:  { type: Number, default: 0 },
  local_hits:   { type: Number, default: 0 },

  // Lifecycle. 'staged' covers monitor + quarantine (disposition says which).
  state:       { type: String, enum: ['staged', 'implemented', 'ignored'], default: 'staged', index: true },
  disposition: { type: String, enum: ['monitor', 'quarantine', 'implement'], default: 'monitor' },

  first_seen_at: { type: Date, default: Date.now },
  last_seen_at:  { type: Date, default: Date.now },   // updated on re-pull
  implemented_at: { type: Date },
  updated_at:    { type: Date, default: Date.now },
});

// One row per (partner, kind, value): re-pulls update rather than duplicate.
SyncStagedEntrySchema.index({ workspace_id: 1, source_partner_id: 1, kind: 1, value: 1 }, { unique: true });
SyncStagedEntrySchema.index({ workspace_id: 1, state: 1, match_status: 1 });

SyncStagedEntrySchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('SyncStagedEntry', SyncStagedEntrySchema);
