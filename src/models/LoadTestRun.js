const mongoose = require('mongoose');

/**
 * A stress-test run: the saved config plus the run record and result summary.
 * The CMS spawns the standalone runner (scripts/loadtestRunner.js) as a child
 * process; the runner updates status and writes `results` back here. The
 * decision breakdown is derived on the detail page by aggregating the tagged
 * synthetic clicks (utm_content = "synthtest-<run_tag>-<source>").
 */
const LoadTestRunSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  name:        { type: String, required: true },
  campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
  campaign_name: { type: String, default: '' },
  target_url:  { type: String, required: true },

  // Test options
  include_utm_gate: { type: Boolean, default: true }, // true = send utm_* (gate participates); false = omit them
  ua_mode:     { type: String, enum: ['builtin', 'custom'], default: 'builtin' },
  custom_uas:  { type: [String], default: [] },
  weights:     { type: String, default: '60,25,15' }, // google,facebook,x
  count:       { type: Number, default: 200 },
  rps:         { type: Number, default: 5 },
  proxy_ids:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'SavedProxy' }],
  loadtest_token: { type: String, default: '' },      // if set, sent as x-botguard-loadtest header

  // Run tracking
  run_tag:     { type: String, index: true },         // unique id used in utm_content + demo click ids
  status:      { type: String, enum: ['draft', 'running', 'done', 'error'], default: 'draft' },
  error:       { type: String, default: '' },
  started_at:  { type: Date },
  finished_at: { type: Date },

  // Result summary written by the runner (throughput/latency/status). Decision
  // breakdown is computed from tagged clicks on the detail page.
  results: {
    total_sent:  { type: Number, default: 0 },
    ok:          { type: Number, default: 0 },
    errors:      { type: Number, default: 0 },
    p50_ms:      { type: Number, default: 0 },
    p95_ms:      { type: Number, default: 0 },
    p99_ms:      { type: Number, default: 0 },
    by_pool:     { type: mongoose.Schema.Types.Mixed, default: {} }, // { poolLabel: {sent,ok,err,status} }
    by_source:   { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  created_at:  { type: Date, default: Date.now },
});

module.exports = mongoose.model('LoadTestRun', LoadTestRunSchema);
