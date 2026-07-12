const mongoose = require('mongoose');

/**
 * SyncPartner — a federated threat-intel link with another BotGuard install.
 *
 * direction:
 *   'export' — a credential WE issue. A partner presents its passcode to pull
 *              OUR shared CIDR/ASN data from GET /sync/feed. We choose what's shared.
 *   'import' — a source WE pull FROM. We store their feed URL + passcode and the
 *              per-partner rules for how their data is treated on arrival.
 *
 * Everything about how imported data is handled lives on the IMPORT partner —
 * the importer is always in control (monitor / quarantine / implement), per the
 * design. Nothing an import partner sends is ever auto-applied unless the
 * importer explicitly configured it that way.
 */
const SyncPartnerSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, required: true },
  direction: { type: String, enum: ['export', 'import'], required: true, index: true },
  name: { type: String, required: true },     // human label for the partner
  enabled: { type: Boolean, default: true },

  // Shared secret. For an export partner this is what the remote side must
  // present. For an import partner it's what WE send when pulling their feed.
  // Stored plaintext to match the existing api_keys pattern and because the
  // owner must be able to re-display/copy it to hand to a partner.
  passcode: { type: String, required: true },

  // ── EXPORT-side config: what this credential is allowed to see ──────
  share: {
    cidr:       { type: Boolean, default: true },
    asn:        { type: Boolean, default: true },
    // Sample IPs are your visitors' addresses — OFF by default. Opt-in only,
    // and only the exporter can turn it on for a partner they trust.
    sample_ips: { type: Boolean, default: false },
    min_score:  { type: Number,  default: 60 },   // only share CIDRs at/above this
  },
  export_count:     { type: Number, default: 0 },
  last_exported_at: { type: Date },
  last_export_size: { type: Number, default: 0 },

  // ── IMPORT-side config: how we treat what we pull ──────────────────
  feed_url: { type: String, default: '' },        // remote GET /sync/feed URL
  pull: {
    cidr: { type: Boolean, default: true },
    asn:  { type: Boolean, default: true },
  },
  // What happens to arriving entries:
  //   monitor    — stage only, for observation; never touches the firewall
  //   quarantine — stage, held explicitly pending review
  //   implement  — eligible for promotion into live data (subject to promotion_mode)
  disposition: { type: String, enum: ['monitor', 'quarantine', 'implement'], default: 'monitor' },

  // How aggressively 'implement' promotes (ignored for monitor/quarantine):
  //   corroboration — implement ONLY entries we've independently seen at/above
  //                   our local thresholds; the rest stay staged
  //   percentage    — if >= match_percentage of the batch matches our data,
  //                   trust the whole list; otherwise stage it all
  //   full          — implement everything (deliberate high-trust choice)
  promotion_mode: { type: String, enum: ['corroboration', 'percentage', 'full'], default: 'corroboration' },
  thresholds: {
    min_local_score: { type: Number, default: 60 },
    min_local_hits:  { type: Number, default: 5 },
    match_percentage: { type: Number, default: 50 },   // for percentage mode
  },
  // Where implemented entries land:
  //   seed   — into CidrIntelligence / AsnBlacklist tagged by source (reuses
  //            the existing block+export pipeline). Recommended.
  //   direct — same targets but flagged for immediate active blocking.
  implement_target: { type: String, enum: ['seed', 'direct'], default: 'seed' },

  // Importer-controlled schedule.
  schedule: {
    mode: { type: String, enum: ['manual', 'interval'], default: 'manual' },
    interval_minutes: { type: Number, default: 1440 },  // default daily
  },

  import_count:     { type: Number, default: 0 },
  last_imported_at: { type: Date },
  last_pull: {
    at:          { type: Date },
    pulled:      { type: Number, default: 0 },  // entries received
    matched:     { type: Number, default: 0 },  // overlapped our data
    new_entries: { type: Number, default: 0 },  // we'd never seen
    staged:      { type: Number, default: 0 },
    implemented: { type: Number, default: 0 },
    skipped:     { type: Number, default: 0 },  // duplicates of active data
    error:       { type: String, default: '' },
  },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

SyncPartnerSchema.index({ workspace_id: 1, direction: 1 });
SyncPartnerSchema.index({ workspace_id: 1, direction: 1, passcode: 1 });

SyncPartnerSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('SyncPartner', SyncPartnerSchema);
