/**
 * analytics.js — UTM / ValueTrack conversion analysis.
 *
 * Self-contained router (mounted at /admin/analytics) so it doesn't require
 * edits to the big shared admin router beyond a one-line mount. Groups clicks
 * by a chosen dimension (placement, campaign, ad group, creative, network,
 * device, utm_*, country) and reports clicks / conversions / conversion-rate,
 * with date-range + campaign + source + medium filters, app-name resolution
 * for app placements, exclude-candidate flagging, and CSV export.
 *
 * Metric note: BotGuard has no ad-spend data, so this is conversion-RATE
 * analysis (CVR = conversions ÷ clicks), not CPA/ROAS.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { DEFAULT_SLUG } = require('../../lib/bootstrap');

async function resolveWs(req) {
  const { Workspace } = require('../../models');
  return Workspace.findOne({ slug: req.params.workspaceSlug || DEFAULT_SLUG });
}

// Dimensions the user can group by. `app:true` triggers app-name resolution.
const DIMENSIONS = {
  placement:    { label: 'Placement (app/site)',   path: 'valuetrack.google.placement', app: true },
  vt_campaign:  { label: 'Campaign ID (ValueTrack)', path: 'valuetrack.google.campaignid' },
  adgroup:      { label: 'Ad Group ID',            path: 'valuetrack.google.adgroupid' },
  creative:     { label: 'Creative / Ad ID',       path: 'valuetrack.google.creative' },
  network:      { label: 'Network',                path: 'valuetrack.google.network' },
  vt_device:    { label: 'Device (ValueTrack)',    path: 'valuetrack.google.device' },
  keyword:      { label: 'Keyword',                path: 'valuetrack.google.keyword' },
  matchtype:    { label: 'Match type',             path: 'valuetrack.google.matchtype' },
  utm_source:   { label: 'UTM Source',             path: 'utm.source' },
  utm_medium:   { label: 'UTM Medium',             path: 'utm.medium' },
  utm_campaign: { label: 'UTM Campaign',           path: 'utm.campaign' },
  utm_content:  { label: 'UTM Content',            path: 'utm.content' },
  utm_term:     { label: 'UTM Term',               path: 'utm.term' },
  country:      { label: 'Country',                path: 'country' },
  campaign:     { label: 'BotGuard Campaign',      path: 'campaign_id', campaignName: true },
};

const DATE_PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'],
  ['this_week', 'This week'], ['last_week', 'Last week'],
  ['this_month', 'This month'], ['last_month', 'Last month'],
  ['last_7', 'Last 7 days'], ['last_30', 'Last 30 days'],
  ['all', 'All time'], ['custom', 'Custom range'],
];

// Compute [start, end) for a preset. Week starts Monday. Server-local time.
function computeRange(preset, q) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const dow = (d) => (d.getDay() + 6) % 7; // 0 = Monday

  let start = null, end = null;
  const t0 = startOfDay(now);
  switch (preset) {
    case 'today': start = t0; end = addDays(t0, 1); break;
    case 'yesterday': start = addDays(t0, -1); end = t0; break;
    case 'this_week': start = addDays(t0, -dow(now)); end = addDays(start, 7); break;
    case 'last_week': end = addDays(t0, -dow(now)); start = addDays(end, -7); break;
    case 'this_month': start = new Date(now.getFullYear(), now.getMonth(), 1); end = new Date(now.getFullYear(), now.getMonth() + 1, 1); break;
    case 'last_month': start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case 'last_7': start = addDays(t0, -6); end = addDays(t0, 1); break;
    case 'last_30': start = addDays(t0, -29); end = addDays(t0, 1); break;
    case 'all': start = null; end = null; break;
    case 'custom': {
      if (q.date_from) start = new Date(q.date_from + 'T00:00:00');
      if (q.date_to) end = addDays(new Date(q.date_to + 'T00:00:00'), 1);
      break;
    }
    default: start = addDays(t0, -6); end = addDays(t0, 1);
  }
  return { start, end };
}

// Build the Mongo match filter from query params.
function buildFilter(ws, q) {
  const preset = DATE_PRESETS.map((p) => p[0]).includes(q.range) ? q.range : 'last_7';
  const { start, end } = computeRange(preset, q);

  const filter = { workspace_id: ws._id };
  if (start || end) {
    filter.ts = {};
    if (start) filter.ts.$gte = start;
    if (end) filter.ts.$lt = end;
  }
  if (q.campaign) { try { filter.campaign_id = q.campaign; } catch (_) {} }
  if (q.source) filter['utm.source'] = q.source;
  if (q.medium) filter['utm.medium'] = q.medium;
  if (q.decision && ['allow', 'block'].includes(q.decision)) filter.decision = q.decision;
  return { filter, preset };
}

// Run the grouped aggregation for a dimension.
async function aggregate(Click, filter, dimKey, limit = 1000) {
  const dim = DIMENSIONS[dimKey] || DIMENSIONS.placement;
  const rows = await Click.aggregate([
    { $match: filter },
    { $group: {
        _id: { $ifNull: [`$${dim.path}`, '(none)'] },
        clicks: { $sum: 1 },
        conversions: { $sum: { $ifNull: ['$conversion_count', 0] } },
    } },
    { $sort: { clicks: -1 } },
    { $limit: limit },
  ]);
  return { dim, rows };
}

// Enrich aggregated rows: campaign names, app names, CVR, exclude flag.
async function enrichRows(rows, dim, minClicks) {
  const { Campaign } = require('../../models');

  // Campaign-name resolution for the BotGuard-campaign dimension.
  if (dim.campaignName) {
    const ids = rows.map((r) => r._id).filter((x) => x && x !== '(none)');
    const camps = await Campaign.find({ _id: { $in: ids } }).select('name').lean().catch(() => []);
    const nameMap = {};
    for (const c of camps) nameMap[String(c._id)] = c.name;
    rows.forEach((r) => { r.label = nameMap[String(r._id)] || String(r._id); });
  }

  // App-name resolution for app placements (mobileapp::1-<id> etc.).
  if (dim.app) {
    const { resolveAppPlacement } = require('../../lib/appLookup');
    for (const r of rows) {
      r.label = String(r._id);
      if (typeof r._id === 'string' && r._id.startsWith('mobileapp::')) {
        try {
          const info = await resolveAppPlacement(r._id);
          if (info && (info.name || info.app_name)) r.label = `${info.name || info.app_name}`;
        } catch (_) {}
      }
    }
  }

  rows.forEach((r) => {
    if (!r.label) r.label = String(r._id);
    r.cvr = r.clicks ? (r.conversions / r.clicks) : 0;
    // Exclude candidate: enough click volume, zero conversions.
    r.exclude_candidate = r.clicks >= minClicks && r.conversions === 0;
  });
  return rows;
}

// Distinct sources/mediums for the filter dropdowns.
async function filterOptions(Click, ws) {
  const [sources, mediums] = await Promise.all([
    Click.distinct('utm.source', { workspace_id: ws._id }).catch(() => []),
    Click.distinct('utm.medium', { workspace_id: ws._id }).catch(() => []),
  ]);
  return {
    sources: (sources || []).filter(Boolean).sort().slice(0, 200),
    mediums: (mediums || []).filter(Boolean).sort().slice(0, 200),
  };
}

router.get('/', async (req, res) => {
  const ws = await resolveWs(req);
  if (!ws) return res.status(404).send('Workspace not found');
  const { Click, Campaign } = require('../../models');

  const dimKey = DIMENSIONS[req.query.dim] ? req.query.dim : 'placement';
  const minClicks = Math.max(1, parseInt(req.query.min, 10) || 30);
  const { filter, preset } = buildFilter(ws, req.query);

  const { dim, rows } = await aggregate(Click, filter, dimKey);
  await enrichRows(rows, dim, minClicks);

  const totals = rows.reduce((a, r) => { a.clicks += r.clicks; a.conversions += r.conversions; return a; }, { clicks: 0, conversions: 0 });

  const [campaigns, opts] = await Promise.all([
    Campaign.find({ workspace_id: ws._id }).select('name').sort({ name: 1 }).lean(),
    filterOptions(Click, ws),
  ]);

  res.render('admin/analytics', {
    ws, page: 'analytics',
    dimensions: DIMENSIONS, datePresets: DATE_PRESETS,
    dimKey, preset, minClicks, rows, totals,
    campaigns, sources: opts.sources, mediums: opts.mediums,
    query: req.query,
  });
});

router.get('/export.csv', async (req, res) => {
  const ws = await resolveWs(req);
  if (!ws) return res.status(404).send('Workspace not found');
  const { Click } = require('../../models');

  const dimKey = DIMENSIONS[req.query.dim] ? req.query.dim : 'placement';
  const minClicks = Math.max(1, parseInt(req.query.min, 10) || 30);
  const { filter } = buildFilter(ws, req.query);
  const { dim, rows } = await aggregate(Click, filter, dimKey);
  await enrichRows(rows, dim, minClicks);

  const esc = (v) => {
    const s = (v == null ? '' : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [['dimension', 'value', 'label', 'clicks', 'conversions', 'cvr_pct', 'exclude_candidate'].join(',')];
  for (const r of rows) {
    lines.push([
      dim.label, r._id, r.label, r.clicks, r.conversions,
      (r.cvr * 100).toFixed(2), r.exclude_candidate ? 'yes' : '',
    ].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="analytics-${dimKey}-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\r\n'));
});

module.exports = router;
module.exports.DIMENSIONS = DIMENSIONS;
module.exports.computeRange = computeRange;
module.exports.buildFilter = buildFilter;
