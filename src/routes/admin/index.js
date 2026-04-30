const express = require('express');
const router = express.Router();

const { resolveSlug } = require('../../lib/slug');
const { Workspace, Campaign, LandingPage, Click, Conversion, AsnBlacklist } = require('../../models');
const { invalidateCache } = require('../../lib/asnLookup');
const { DEFAULT_SLUG } = require('../../lib/bootstrap');
const { replay } = require('../../lib/replay');
const { PROFILES } = require('../../scoring/profiles');
const { requireAdmin, loginPage, loginSubmit, logout } = require('../../middleware/auth');
const logger = require('../../lib/logger');

// --- Login / logout (must be defined BEFORE requireAdmin gate) ---
router.get('/login', loginPage);
router.post('/login', loginSubmit);
router.get('/logout', logout);

// --- Everything below this gate requires authentication ---
router.use(requireAdmin);

// Resolve workspace - week 1 single tenant, defaults to env var workspace
async function resolveWorkspace(req) {
  const slug = req.params.workspaceSlug || DEFAULT_SLUG;
  return Workspace.findOne({ slug });
}

// ---------- Dashboard ----------
router.get('/', async (req, res) => {
  const ws = await resolveWorkspace(req);
  if (!ws) return res.status(404).send('Workspace not found');

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [clicks24h, clicks7d, conversions24h, decisionBreakdown, topSources, recentClicks] = await Promise.all([
    Click.countDocuments({ workspace_id: ws._id, ts: { $gte: since24h } }),
    Click.countDocuments({ workspace_id: ws._id, ts: { $gte: since7d } }),
    Conversion.countDocuments({ workspace_id: ws._id, ts: { $gte: since24h } }),
    Click.aggregate([
      { $match: { workspace_id: ws._id, ts: { $gte: since7d } } },
      { $group: { _id: '$decision', count: { $sum: 1 } } },
    ]),
    Click.aggregate([
      { $match: { workspace_id: ws._id, ts: { $gte: since7d }, 'utm.source': { $ne: null } } },
      { $group: { _id: '$utm.source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    Click.find({ workspace_id: ws._id })
      .sort({ ts: -1 })
      .limit(20)
      .populate('campaign_id', 'name slug')
      .lean(),
  ]);

  res.render('admin/dashboard', {
    ws,
    stats: { clicks24h, clicks7d, conversions24h },
    decisionBreakdown,
    topSources,
    recentClicks,
    page: 'dashboard',
  });
});

// ---------- Campaigns ----------
router.get('/campaigns', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const campaigns = await Campaign.find({ workspace_id: ws._id })
    .populate('landing_page_id', 'name slug')
    .sort({ updated_at: -1 })
    .lean();
  res.render('admin/campaigns', { ws, campaigns, page: 'campaigns' });
});

router.get('/campaigns/new', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const pages = await LandingPage.find({ workspace_id: ws._id }).sort({ name: 1 }).lean();
  res.render('admin/campaign_form', { ws, campaign: null, pages, page: 'campaigns' });
});

router.post('/campaigns', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  try {
    // Auto-resolve slug from name if not provided, append digits on collision
    const slug = await resolveSlug(body.slug, body.name, async (s) => {
      return !!(await Campaign.exists({ workspace_id: ws._id, slug: s }));
    });

    // UTM gate config
    const utmGate = {
      enabled: body.utm_gate_enabled === 'on' || body.utm_gate_enabled === 'true',
      required_keys: parseRequiredUtmKeys(body.utm_required_keys),
    };

    // Country gate config
    const countryGate = parseCountryGate(body);

    // Proxy gate config
    const proxyGate = parseProxyGate(body);

    await Campaign.create({
      workspace_id: ws._id,
      slug,
      name: body.name,
      status: body.status || 'active',
      landing_page_id: body.landing_page_id || null,
      safe_page_id: body.safe_page_id || null,
      source_profile: body.source_profile || 'mixed',
      filter_config: {
        threshold: Number(body.threshold) || 70,
        mode: body.mode || 'log_only',
        utm_gate: utmGate,
        country_gate: countryGate,
        proxy_gate: proxyGate,
      },
      postback_url: body.postback_url || '',
      notes: body.notes || '',
    });
    res.redirect('/admin/campaigns');
  } catch (err) {
    res.status(400).send(`Error: ${err.message}`);
  }
});

// Parse UTM required keys from form input - either a comma-separated string
// or an array (when multiple checkboxes share the name)
function parseRequiredUtmKeys(input) {
  const valid = new Set(['source', 'medium', 'campaign', 'term', 'content']);
  let keys = [];
  if (Array.isArray(input)) {
    keys = input;
  } else if (typeof input === 'string' && input.trim()) {
    keys = input.split(',').map((s) => s.trim());
  } else {
    keys = ['source', 'medium', 'campaign'];   // sensible default
  }
  return keys.filter((k) => valid.has(k));
}

// Parse country gate config from form body.
// `country_list` arrives as a comma/newline-separated textarea; we sanitize to ISO codes.
function parseCountryGate(body) {
  const raw = String(body.country_list || '');
  const codes = raw
    .split(/[\s,;]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));    // ISO 3166-1 alpha-2 only
  // Dedupe
  const unique = Array.from(new Set(codes));
  return {
    enabled: body.country_gate_enabled === 'on' || body.country_gate_enabled === 'true',
    mode: body.country_gate_mode === 'blacklist' ? 'blacklist' : 'whitelist',
    countries: unique,
    on_unknown: body.country_gate_on_unknown === 'block' ? 'block' : 'allow',
  };
}

function parseProxyGate(body) {
  // For checkboxes: present in body = checked, absent = unchecked.
  // We default the toggles ON (common case is to block these), so the form must
  // explicitly send empty values for OFF. We handle this by checking for a sentinel
  // hidden field that's always present alongside each checkbox.
  return {
    enabled: body.proxy_gate_enabled === 'on' || body.proxy_gate_enabled === 'true',
    block_vpn: body.proxy_block_vpn === 'on',
    block_tor: body.proxy_block_tor === 'on',
    block_public_proxy: body.proxy_block_public_proxy === 'on',
    block_compromised: body.proxy_block_compromised === 'on',
    block_hosting: body.proxy_block_hosting === 'on',
    max_risk_score: clamp(Number(body.proxy_max_risk_score), 0, 100, 100),
  };
}

function clamp(n, min, max, fallback) {
  if (typeof n !== 'number' || Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

router.get('/campaigns/:id/edit', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const campaign = await Campaign.findOne({ _id: req.params.id, workspace_id: ws._id }).lean();
  if (!campaign) return res.status(404).send('Campaign not found');
  const pages = await LandingPage.find({ workspace_id: ws._id }).sort({ name: 1 }).lean();
  res.render('admin/campaign_form', { ws, campaign, pages, page: 'campaigns' });
});

router.post('/campaigns/:id', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  try {
    // Resolve slug only if user actually edited it; if blank, derive from name.
    // Exclude the current campaign from collision check so saving without slug change works.
    const existing = await Campaign.findOne({ _id: req.params.id, workspace_id: ws._id });
    if (!existing) return res.status(404).send('Campaign not found');

    let slug = existing.slug;
    const requestedSlug = body.slug || '';
    if (requestedSlug !== existing.slug || !requestedSlug) {
      slug = await resolveSlug(requestedSlug, body.name, async (s) => {
        if (s === existing.slug) return false;   // its own current slug doesn't count as collision
        return !!(await Campaign.exists({ workspace_id: ws._id, slug: s, _id: { $ne: existing._id } }));
      });
    }

    const utmGate = {
      enabled: body.utm_gate_enabled === 'on' || body.utm_gate_enabled === 'true',
      required_keys: parseRequiredUtmKeys(body.utm_required_keys),
    };
    const countryGate = parseCountryGate(body);
    const proxyGate = parseProxyGate(body);

    await Campaign.updateOne(
      { _id: req.params.id, workspace_id: ws._id },
      {
        $set: {
          slug,
          name: body.name,
          status: body.status,
          landing_page_id: body.landing_page_id || null,
          safe_page_id: body.safe_page_id || null,
          source_profile: body.source_profile,
          'filter_config.threshold': Number(body.threshold) || 70,
          'filter_config.mode': body.mode,
          'filter_config.utm_gate': utmGate,
          'filter_config.country_gate': countryGate,
          'filter_config.proxy_gate': proxyGate,
          postback_url: body.postback_url || '',
          notes: body.notes || '',
        },
      }
    );
    res.redirect('/admin/campaigns');
  } catch (err) {
    res.status(400).send(`Error: ${err.message}`);
  }
});

router.post('/campaigns/:id/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  await Campaign.deleteOne({ _id: req.params.id, workspace_id: ws._id });
  res.redirect('/admin/campaigns');
});

// ---------- Landing pages ----------
router.get('/pages', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const pages = await LandingPage.find({ workspace_id: ws._id }).sort({ updated_at: -1 }).lean();
  res.render('admin/pages', { ws, pages, page: 'pages' });
});

router.get('/pages/new', async (req, res) => {
  const ws = await resolveWorkspace(req);
  res.render('admin/page_form', { ws, lp: null, page: 'pages' });
});

router.post('/pages', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  try {
    const slug = await resolveSlug(body.slug, body.name, async (s) => {
      return !!(await LandingPage.exists({ workspace_id: ws._id, slug: s }));
    });

    await LandingPage.create({
      workspace_id: ws._id,
      slug,
      name: body.name,
      kind: body.kind || 'offer',
      html_template: body.html_template || '',
    });
    res.redirect('/admin/pages');
  } catch (err) {
    res.status(400).send(`Error: ${err.message}`);
  }
});

router.get('/pages/:id/edit', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const lp = await LandingPage.findOne({ _id: req.params.id, workspace_id: ws._id }).lean();
  if (!lp) return res.status(404).send('Page not found');
  res.render('admin/page_form', { ws, lp, page: 'pages' });
});

router.post('/pages/:id', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  try {
    const existing = await LandingPage.findOne({ _id: req.params.id, workspace_id: ws._id });
    if (!existing) return res.status(404).send('Page not found');

    let slug = existing.slug;
    const requestedSlug = body.slug || '';
    if (requestedSlug !== existing.slug || !requestedSlug) {
      slug = await resolveSlug(requestedSlug, body.name, async (s) => {
        if (s === existing.slug) return false;
        return !!(await LandingPage.exists({ workspace_id: ws._id, slug: s, _id: { $ne: existing._id } }));
      });
    }

    await LandingPage.updateOne(
      { _id: req.params.id, workspace_id: ws._id },
      {
        $set: {
          slug,
          name: body.name,
          kind: body.kind,
          html_template: body.html_template || '',
        },
      }
    );
    res.redirect('/admin/pages');
  } catch (err) {
    res.status(400).send(`Error: ${err.message}`);
  }
});

router.post('/pages/:id/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  await LandingPage.deleteOne({ _id: req.params.id, workspace_id: ws._id });
  res.redirect('/admin/pages');
});

// ---------- Click log ----------
router.get('/clicks', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = { workspace_id: ws._id };
  if (req.query.campaign) filter.campaign_id = req.query.campaign;
  if (req.query.decision) filter.decision = req.query.decision;
  if (req.query.source) filter['utm.source'] = req.query.source;

  const clicks = await Click.find(filter)
    .sort({ ts: -1 })
    .limit(200)
    .populate('campaign_id', 'name slug')
    .lean();

  const campaigns = await Campaign.find({ workspace_id: ws._id }).select('name slug').lean();

  res.render('admin/clicks', { ws, clicks, campaigns, query: req.query, page: 'clicks' });
});

// ---------- ASN blacklist ----------
router.get('/asn', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const entries = await AsnBlacklist.find({
    $or: [{ workspace_id: ws._id }, { workspace_id: null }],
  })
    .sort({ category: 1, asn: 1 })
    .lean();
  res.render('admin/asn', { ws, entries, page: 'asn' });
});

router.post('/asn', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  try {
    const ruleType = body.rule_type || 'asn';
    const doc = {
      workspace_id: body.scope === 'global' ? null : ws._id,
      asn_org: body.asn_org || '',
      category: body.category,
      severity: body.severity || 'high',
      score_weight: Number(body.score_weight) || 50,
      override: body.override || 'mark_proxy',
      source: body.source || 'manual',
      notes: body.notes || '',
      active: true,
    };
    if (ruleType === 'term') {
      doc.term = (body.term || '').trim().toLowerCase();
      doc.term_field = body.term_field || 'any';
      if (!doc.term) throw new Error('Term is required for term rules');
    } else {
      doc.asn = body.asn ? Number(body.asn) : null;
      if (!doc.asn) throw new Error('ASN is required for ASN rules');
    }
    await AsnBlacklist.create(doc);
    invalidateCache();
    res.redirect('/admin/asn');
  } catch (err) {
    res.status(400).send(`Error: ${err.message}`);
  }
});

router.post('/asn/:id/toggle', async (req, res) => {
  const entry = await AsnBlacklist.findById(req.params.id);
  if (entry) {
    entry.active = !entry.active;
    await entry.save();
    invalidateCache();
  }
  res.redirect('/admin/asn');
});

router.post('/asn/:id/delete', async (req, res) => {
  await AsnBlacklist.deleteOne({ _id: req.params.id });
  invalidateCache();
  res.redirect('/admin/asn');
});

// ---------- Settings (API keys, password info) ----------
router.get('/settings', async (req, res) => {
  const ws = await resolveWorkspace(req);
  res.render('admin/settings', { ws, page: 'settings', adminUser: req.adminUser, generated: req.query.key || null });
});

router.post('/settings/api-keys', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const label = (req.body?.label || 'unnamed').slice(0, 60);
  const key = 'bgk_' + require('crypto').randomBytes(24).toString('base64url');
  await Workspace.updateOne(
    { _id: ws._id },
    { $push: { api_keys: { key, label, created_at: new Date() } } }
  );
  res.redirect('/admin/settings?key=' + encodeURIComponent(key));
});

router.post('/settings/api-keys/:key/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  await Workspace.updateOne(
    { _id: ws._id },
    { $pull: { api_keys: { key: req.params.key } } }
  );
  res.redirect('/admin/settings');
});

// ---------- Click detail ----------
router.get('/clicks/:id', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const click = await Click.findOne({ click_id: req.params.id, workspace_id: ws._id })
    .populate('campaign_id', 'name slug source_profile filter_config')
    .lean();
  if (!click) return res.status(404).send('Click not found');
  const conversions = await Conversion.find({ click_id: click.click_id }).sort({ ts: -1 }).lean();
  res.render('admin/click_detail', { ws, click, conversions, page: 'clicks' });
});

// ---------- Decision replay ----------
router.get('/replay', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const campaigns = await Campaign.find({ workspace_id: ws._id }).select('name slug').lean();
  res.render('admin/replay', { ws, campaigns, profiles: Object.keys(PROFILES), result: null, query: {}, page: 'replay' });
});

router.post('/replay', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  const campaigns = await Campaign.find({ workspace_id: ws._id }).select('name slug').lean();

  const filter = {};
  if (body.campaign) filter.campaign_id = body.campaign;
  if (body.from) filter.ts = { ...(filter.ts || {}), $gte: new Date(body.from) };
  if (body.to)   filter.ts = { ...(filter.ts || {}), $lte: new Date(body.to) };

  const hypothetical = {
    threshold: Number(body.threshold) || 70,
    mode: body.mode || 'enforce',
    profile: body.profile || null,
  };

  let result = null;
  try {
    result = await replay({ workspaceId: ws._id, filter, hypothetical });
  } catch (err) {
    logger.error('replay_error', { err: err.message });
  }

  res.render('admin/replay', {
    ws, campaigns, profiles: Object.keys(PROFILES),
    result, query: { ...body, ...hypothetical }, page: 'replay',
  });
});

module.exports = router;
