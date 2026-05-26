/**
 * /admin/cloudflare routes — Cloudflare Worker edge firewall management.
 *
 * Config needed in .env:
 *   CF_ACCOUNT_ID       — Cloudflare account ID
 *   CF_API_TOKEN        — API token with Workers KV Storage Edit permission
 *   CF_KV_NAMESPACE_ID  — KV namespace ID
 */

'use strict';

const express = require('express');
const router = express.Router();

const CloudflareRule = require('../../models/CloudflareRule');
const AsnBlacklist = require('../../models/AsnBlacklist');
const CidrIntelligence = require('../../models/CidrIntelligence');
const { buildBlocklist, syncToCloudflareKV } = require('../../lib/cloudflareSync');
const { deployWorker, undeployWorker, verifyDeployment } = require('../../lib/workerDeploy');

async function resolveWorkspace(req) {
  const { Workspace } = require('../../models');
  const { DEFAULT_SLUG } = require('../../lib/bootstrap');
  const slug = req.params?.workspaceSlug || DEFAULT_SLUG;
  return Workspace.findOne({ slug });
}

// ── Main list view ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const typeFilter = req.query.type || 'all';
  const statusFilter = req.query.status || 'active';

  const filter = { workspace_id: ws._id };
  if (typeFilter !== 'all') filter.rule_type = typeFilter;
  if (statusFilter === 'active') filter.active = true;
  else if (statusFilter === 'inactive') filter.active = false;

  const entries = await CloudflareRule.find(filter)
    .sort({ rule_type: 1, created_at: -1 }).lean();

  const stats = {
    total: await CloudflareRule.countDocuments({ workspace_id: ws._id, active: true }),
    cidrs: await CloudflareRule.countDocuments({ workspace_id: ws._id, active: true, rule_type: 'cidr' }),
    ips: await CloudflareRule.countDocuments({ workspace_id: ws._id, active: true, rule_type: 'ip' }),
    asns: await CloudflareRule.countDocuments({ workspace_id: ws._id, active: true, rule_type: 'asn' }),
    needs_sync: await CloudflareRule.countDocuments({ workspace_id: ws._id, active: true, needs_sync: true }),
  };

  const cfConfigured = !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN && process.env.CF_KV_NAMESPACE_ID);
  const cfSettings = ws.settings?.cloudflare_settings || { enabled: false, scan_mode: 'utm' };

  res.render('admin/cloudflare', {
    ws, entries, stats, page: 'cloudflare',
    typeFilter, statusFilter,
    cfConfigured, cfSettings,
    flash: req.query.flash || '',
  });
});

// ── Enable / disable the Worker ──────────────────────────────────────
router.post('/toggle-enabled', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const current = ws.settings?.cloudflare_settings?.enabled ?? false;
  await ws.constructor.updateOne(
    { _id: ws._id },
    { $set: { 'settings.cloudflare_settings.enabled': !current } }
  );
  // Auto-sync so the Worker picks up the change
  try { await syncToCloudflareKV(ws._id); } catch (e) { /* non-fatal */ }
  res.redirect(`/admin/cloudflare?flash=Edge+firewall+${!current ? 'enabled' : 'disabled'}`);
});

// ── Switch scan mode ─────────────────────────────────────────────────
router.post('/scan-mode', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const mode = req.body.scan_mode === 'all' ? 'all' : 'utm';
  await ws.constructor.updateOne(
    { _id: ws._id },
    { $set: { 'settings.cloudflare_settings.scan_mode': mode } }
  );
  try { await syncToCloudflareKV(ws._id); } catch (e) { /* non-fatal */ }
  res.redirect(`/admin/cloudflare?flash=Scan+mode+set+to+${mode}`);
});

// ── Add single rule ──────────────────────────────────────────────────
router.post('/add', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const { rule_type, value, asn_number, label, notes, action } = req.body;
  try {
    const doc = {
      workspace_id: ws._id, rule_type,
      action: action || 'block', label: label || '',
      notes: notes || '', source: 'manual', active: true,
    };
    if (rule_type === 'asn') {
      doc.asn_number = parseInt(asn_number, 10);
      if (!doc.asn_number) throw new Error('Valid ASN number required');
    } else {
      doc.value = (value || '').trim();
      if (!doc.value) throw new Error('IP or CIDR value required');
    }
    // Check for existing
    const existsQ = { workspace_id: ws._id, rule_type };
    if (rule_type === 'asn') existsQ.asn_number = doc.asn_number;
    else existsQ.value = doc.value;
    if (await CloudflareRule.findOne(existsQ)) return res.redirect('/admin/cloudflare?flash=Rule+already+exists');
    await CloudflareRule.create(doc);
    res.redirect('/admin/cloudflare?flash=Rule+added');
  } catch (err) {
    if (err.code === 11000) res.redirect('/admin/cloudflare?flash=Rule+already+exists');
    else res.redirect(`/admin/cloudflare?flash=Error:+${encodeURIComponent(err.message)}`);
  }
});

// ── CSV / bulk paste ─────────────────────────────────────────────────
router.post('/upload-csv', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const text = req.body.csv_text || '';
  if (!text.trim()) return res.redirect('/admin/cloudflare?flash=No+data+entered');

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  let added = 0, skipped = 0, invalid = 0;
  for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    let value = parts[0], ruleType = (parts[1] || '').toLowerCase(), label = parts[2] || '';

    if (!ruleType || !['ip', 'cidr', 'asn'].includes(ruleType)) {
      if (/^\d+$/.test(value)) ruleType = 'asn';
      else if (value.includes('/')) ruleType = 'cidr';
      else if (value.includes('*')) { value = value.replace('.*', '.0/24'); ruleType = 'cidr'; }
      else if (/^[\d.:a-fA-F]+$/.test(value)) ruleType = 'ip';
      else { invalid++; continue; }
    }

    try {
      const doc = { workspace_id: ws._id, rule_type: ruleType, action: 'block', label, source: 'csv_upload', active: true };
      if (ruleType === 'asn') { doc.asn_number = parseInt(value, 10); if (!doc.asn_number) { invalid++; continue; } }
      else doc.value = value;
      // Check for existing before create
      const existsQuery = { workspace_id: ws._id, rule_type: ruleType };
      if (ruleType === 'asn') existsQuery.asn_number = doc.asn_number;
      else existsQuery.value = value;
      const exists = await CloudflareRule.findOne(existsQuery);
      if (exists) { skipped++; continue; }
      await CloudflareRule.create(doc);
      added++;
    } catch (err) { if (err.code === 11000) skipped++; else invalid++; }
  }
  res.redirect(`/admin/cloudflare?flash=CSV:+${added}+added,+${skipped}+existing,+${invalid}+invalid`);
});

// ── Import from /admin/asn ───────────────────────────────────────────
router.post('/import-asn', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const ids = (req.body.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.redirect('/admin/cloudflare?flash=No+rules+selected');

  const asnRules = await AsnBlacklist.find({ _id: { $in: ids } }).lean();
  let added = 0, skipped = 0;
  for (const rule of asnRules) {
    try {
      const ruleType = rule.asn ? 'asn' : (rule.cidr ? 'cidr' : 'ip');
      // Check for existing rule
      const existsQuery = { workspace_id: ws._id, rule_type: ruleType };
      if (ruleType === 'asn') existsQuery.asn_number = rule.asn;
      else if (rule.cidr) existsQuery.value = rule.cidr;
      else { skipped++; continue; }
      const exists = await CloudflareRule.findOne(existsQuery);
      if (exists) { skipped++; continue; }

      const doc = {
        workspace_id: ws._id, rule_type: ruleType,
        action: 'block', label: rule.asn_org || '',
        notes: `From ASN blacklist (${rule.category})`,
        source: 'asn_import', source_ref: rule._id.toString(), active: true,
      };
      if (ruleType === 'asn') doc.asn_number = rule.asn;
      else doc.value = rule.cidr;
      await CloudflareRule.create(doc);
      added++;
    } catch (err) { if (err.code === 11000) skipped++; }
  }
  res.redirect(`/admin/cloudflare?flash=ASN+import:+${added}+added,+${skipped}+existing`);
});

// ── Import from /admin/intelligence ──────────────────────────────────
router.post('/import-intelligence', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const ids = (req.body.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.redirect('/admin/cloudflare?flash=No+blocks+selected');

  const entries = await CidrIntelligence.find({ _id: { $in: ids } }).lean();
  let added = 0, skipped = 0;
  for (const entry of entries) {
    // Check if this CIDR already exists in CloudflareRule
    const exists = await CloudflareRule.findOne({
      workspace_id: ws._id,
      rule_type: 'cidr',
      value: entry.cidr,
    });
    if (exists) { skipped++; continue; }

    try {
      await CloudflareRule.create({
        workspace_id: ws._id, rule_type: 'cidr', value: entry.cidr,
        action: 'block', label: entry.asn_org || '',
        notes: `Score ${entry.score}, ${entry.hit_count} hits, ${entry.days_seen_count} days`,
        source: 'intelligence', source_ref: entry._id.toString(), active: true,
      });
      // Mark the intelligence entry as exported to Cloudflare
      await CidrIntelligence.updateOne(
        { _id: entry._id },
        { $set: { cf_exported: true, cf_exported_at: new Date() } }
      );
      added++;
    } catch (err) { if (err.code === 11000) skipped++; }
  }
  res.redirect(`/admin/intelligence?flash=Cloudflare:+${added}+added,+${skipped}+existing`);
});

// ── Toggle / Delete ──────────────────────────────────────────────────
router.post('/:id/toggle', async (req, res) => {
  const rule = await CloudflareRule.findById(req.params.id);
  if (rule) { rule.active = !rule.active; await rule.save(); }
  res.redirect('/admin/cloudflare');
});

router.post('/:id/delete', async (req, res) => {
  const rule = await CloudflareRule.findById(req.params.id);
  if (rule) {
    // If this rule came from intelligence, reset the cf_exported flag
    // so the CIDR can be re-added later
    if (rule.source === 'intelligence' && rule.source_ref) {
      await CidrIntelligence.updateOne(
        { _id: rule.source_ref },
        { $set: { cf_exported: false, cf_exported_at: null } }
      );
    }
    // Also reset by matching the CIDR value (covers rules added without source_ref)
    if (rule.rule_type === 'cidr' && rule.value) {
      const ws = await resolveWorkspace(req);
      await CidrIntelligence.updateMany(
        { workspace_id: ws._id, cidr: rule.value },
        { $set: { cf_exported: false, cf_exported_at: null } }
      );
    }
    await CloudflareRule.deleteOne({ _id: req.params.id });
  }
  res.redirect('/admin/cloudflare');
});

router.post('/bulk-delete', async (req, res) => {
  const ids = (req.body.ids || '').split(',').filter(Boolean);
  if (ids.length) {
    const ws = await resolveWorkspace(req);
    // Find rules before deleting so we can reset cf_exported
    const rules = await CloudflareRule.find({ _id: { $in: ids } }).lean();
    const sourceRefIds = [];
    const cidrValues = [];
    for (const r of rules) {
      if (r.source === 'intelligence' && r.source_ref) sourceRefIds.push(r.source_ref);
      if (r.rule_type === 'cidr' && r.value) cidrValues.push(r.value);
    }
    // Reset cf_exported by source_ref
    if (sourceRefIds.length) {
      await CidrIntelligence.updateMany(
        { _id: { $in: sourceRefIds } },
        { $set: { cf_exported: false, cf_exported_at: null } }
      );
    }
    // Also reset by CIDR value match
    if (cidrValues.length) {
      await CidrIntelligence.updateMany(
        { workspace_id: ws._id, cidr: { $in: cidrValues } },
        { $set: { cf_exported: false, cf_exported_at: null } }
      );
    }
    await CloudflareRule.deleteMany({ _id: { $in: ids } });
  }
  res.redirect(`/admin/cloudflare?flash=${ids.length}+rules+deleted`);
});

// ── Push to Cloudflare KV ────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  const ws = await resolveWorkspace(req);
  try {
    const result = await syncToCloudflareKV(ws._id);
    if (result.success) res.redirect(`/admin/cloudflare?flash=Synced+${result.rules}+rules+(${Math.round(result.payload_bytes/1024)}KB)`);
    else res.redirect(`/admin/cloudflare?flash=Sync+failed:+${result.reason || JSON.stringify(result.errors)}`);
  } catch (err) {
    res.redirect(`/admin/cloudflare?flash=Sync+error:+${encodeURIComponent(err.message)}`);
  }
});

// ── Deploy Worker to Cloudflare ──────────────────────────────────────
router.post('/deploy', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const domain = req.body.domain || '';
  if (!domain) return res.redirect('/admin/cloudflare?flash=Domain+is+required');

  try {
    const serverUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const result = await deployWorker(domain, serverUrl);
    await ws.constructor.updateOne(
      { _id: ws._id },
      { $set: {
        'settings.cloudflare_settings.worker_deployed': true,
        'settings.cloudflare_settings.worker_name': result.workerName,
        'settings.cloudflare_settings.worker_zone_id': result.zoneId,
        'settings.cloudflare_settings.worker_route_id': result.routeId,
        'settings.cloudflare_settings.worker_domain': domain,
        'settings.cloudflare_settings.last_deployed_at': new Date(),
        'settings.cloudflare_settings.deploy_error': '',
      }}
    );
    // Auto-sync rules so the Worker has data immediately
    try { await syncToCloudflareKV(ws._id); } catch (e) { /* non-fatal */ }
    res.redirect(`/admin/cloudflare?flash=Worker+deployed+to+${encodeURIComponent(domain)}`);
  } catch (err) {
    await ws.constructor.updateOne(
      { _id: ws._id },
      { $set: { 'settings.cloudflare_settings.deploy_error': err.message } }
    );
    res.redirect(`/admin/cloudflare?flash=Deploy+failed:+${encodeURIComponent(err.message)}`);
  }
});

// ── Undeploy Worker from Cloudflare ──────────────────────────────────
router.post('/undeploy', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const cfSettings = ws.settings?.cloudflare_settings || {};
  try {
    await undeployWorker(
      cfSettings.worker_domain,
      cfSettings.worker_name,
      cfSettings.worker_zone_id,
      cfSettings.worker_route_id
    );
    await ws.constructor.updateOne(
      { _id: ws._id },
      { $set: {
        'settings.cloudflare_settings.worker_deployed': false,
        'settings.cloudflare_settings.worker_name': '',
        'settings.cloudflare_settings.worker_zone_id': '',
        'settings.cloudflare_settings.worker_route_id': '',
        'settings.cloudflare_settings.worker_domain': '',
        'settings.cloudflare_settings.enabled': false,
        'settings.cloudflare_settings.deploy_error': '',
      }}
    );
    res.redirect('/admin/cloudflare?flash=Worker+removed+from+Cloudflare');
  } catch (err) {
    res.redirect(`/admin/cloudflare?flash=Undeploy+failed:+${encodeURIComponent(err.message)}`);
  }
});

// ── Logs view ────────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const CloudflareLog = require('../../models/CloudflareLog');

  const actionFilter = req.query.action || 'all';
  const searchIp = (req.query.ip || '').trim();
  const perPage = Math.min(parseInt(req.query.per_page, 10) || 100, 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const filter = { workspace_id: ws._id };
  if (actionFilter !== 'all') filter.action = actionFilter;
  if (searchIp) filter.ip = { $regex: searchIp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };

  const totalLogs = await CloudflareLog.countDocuments(filter);
  const logs = await CloudflareLog.find(filter)
    .sort({ ts: -1 })
    .skip((page - 1) * perPage)
    .limit(perPage)
    .lean();

  // Stats
  const now = new Date();
  const h24 = new Date(now - 24 * 60 * 60 * 1000);
  const [total24h, blocked24h, allowed24h] = await Promise.all([
    CloudflareLog.countDocuments({ workspace_id: ws._id, ts: { $gte: h24 } }),
    CloudflareLog.countDocuments({ workspace_id: ws._id, ts: { $gte: h24 }, action: 'block' }),
    CloudflareLog.countDocuments({ workspace_id: ws._id, ts: { $gte: h24 }, action: 'allow' }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalLogs / perPage));

  res.render('admin/cloudflare-logs', {
    ws, page: 'cloudflare', logs,
    actionFilter, searchIp,
    stats: { total24h, blocked24h, allowed24h },
    currentPage: page, perPage, totalLogs, totalPages,
  });
});

// ── Log ingestion API (called by the Worker) ─────────────────────────
// The Worker POSTs log data here after each decision.
// Authenticated via CF_SYNC_KEY in the x-botguard-key header.
// This route is NOT behind requireAdmin — it's called by the Worker.
router.post('/api/log', async (req, res) => {
  const syncKey = process.env.CF_SYNC_KEY;
  if (!syncKey) return res.status(503).json({ error: 'CF_SYNC_KEY not set' });

  const key = req.headers['x-botguard-key'];
  if (!key || key !== syncKey) return res.status(401).json({ error: 'unauthorized' });

  const CloudflareLog = require('../../models/CloudflareLog');
  const { Workspace } = require('../../models');

  // Get workspace
  const ws = await Workspace.findOne().lean();
  if (!ws) return res.status(404).json({ error: 'no workspace' });

  const d = req.body;
  try {
    await CloudflareLog.create({
      workspace_id: ws._id,
      ip: d.ip || '',
      asn: d.asn || null,
      country: d.country || '',
      user_agent: d.user_agent || '',
      url: d.url || '',
      method: d.method || 'GET',
      action: d.action || 'allow',
      reason: d.reason || '',
      matched_rule: d.matched_rule || '',
      scan_mode: d.scan_mode || '',
      processing_ms: d.processing_ms || 0,
      ts: new Date(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Export as plain text ─────────────────────────────────────────────
router.get('/export', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const rules = await CloudflareRule.find({ workspace_id: ws._id, active: true })
    .sort({ rule_type: 1, value: 1 }).lean();
  const lines = rules.map(r => r.rule_type === 'asn' ? `AS${r.asn_number}` : r.value);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="cloudflare-rules-${new Date().toISOString().slice(0,10)}.txt"`);
  res.send(lines.join('\n'));
});

module.exports = router;
