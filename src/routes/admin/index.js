const express = require('express');
const router = express.Router();

const { resolveSlug } = require('../../lib/slug');
const cache = require('../../lib/cache');
const { Workspace, Campaign, LandingPage, Click, Conversion, AsnBlacklist, SitePage } = require('../../models');
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

// Admin pages must never be cached (would leak session-specific data via shared CDN cache)
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.set('CDN-Cache-Control', 'no-store');
  next();
});

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

    // Per-device pages
    const devicePages = parseDevicePages(body.device_pages);

    await Campaign.create({
      workspace_id: ws._id,
      slug,
      name: body.name,
      status: body.status || 'active',
      landing_page_id: body.landing_page_id || null,
      safe_page_id: body.safe_page_id || null,
      device_pages: devicePages,
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

// Parse the device_pages nested form input: { iphone: { offer: id, safe: id }, ... }
// Empty strings (—use default—) are converted to null so Mongoose stores nothing for them.
function parseDevicePages(input) {
  const out = {};
  const validClasses = ['iphone', 'android', 'windows', 'mac', 'linux', 'other'];
  if (!input || typeof input !== 'object') return out;
  for (const cls of validClasses) {
    const entry = input[cls];
    if (!entry || typeof entry !== 'object') continue;
    const offer = entry.offer && entry.offer.trim() ? entry.offer : null;
    const safe = entry.safe && entry.safe.trim() ? entry.safe : null;
    if (offer || safe) {
      out[cls] = {};
      if (offer) out[cls].offer = offer;
      if (safe) out[cls].safe = safe;
    }
  }
  return out;
}

// Parse auto-conversion settings from the page form. Terms come in as a textarea
// (one term per line). We strip whitespace, drop empties, dedupe, and limit to 50 terms
// to prevent abuse where someone pastes a 10MB file.
function parseAutoConversion(body) {
  const enabled = body.auto_conversion_enabled === 'on' || body.auto_conversion_enabled === 'true';
  let terms = [];
  if (typeof body.auto_conversion_terms === 'string' && body.auto_conversion_terms.trim()) {
    terms = body.auto_conversion_terms
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 50);
    terms = Array.from(new Set(terms)).slice(0, 50);
  }
  const eventName = (body.auto_conversion_event_name || 'auto_click').trim().slice(0, 50) || 'auto_click';
  return { enabled, terms, event_name: eventName };
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
    const devicePages = parseDevicePages(body.device_pages);

    await Campaign.updateOne(
      { _id: req.params.id, workspace_id: ws._id },
      {
        $set: {
          slug,
          name: body.name,
          status: body.status,
          landing_page_id: body.landing_page_id || null,
          safe_page_id: body.safe_page_id || null,
          device_pages: devicePages,
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
    // Invalidate both old and new slug to handle slug renames
    await cache.invalidateCampaign(ws._id, existing.slug);
    if (slug !== existing.slug) await cache.invalidateCampaign(ws._id, slug);
    res.redirect('/admin/campaigns');
  } catch (err) {
    res.status(400).send(`Error: ${err.message}`);
  }
});

router.post('/campaigns/:id/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const camp = await Campaign.findOne({ _id: req.params.id, workspace_id: ws._id }).select('slug').lean();
  await Campaign.deleteOne({ _id: req.params.id, workspace_id: ws._id });
  if (camp) await cache.invalidateCampaign(ws._id, camp.slug);
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
      auto_conversion: parseAutoConversion(body),
    });
    // Invalidate any campaigns whose render path might cache this page (cache is on campaign-by-slug)
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
          auto_conversion: parseAutoConversion(body),
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

// ---------- Conversions ----------
router.get('/conversions', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = { workspace_id: ws._id };

  if (req.query.campaign) filter.campaign_id = req.query.campaign;
  if (req.query.source) filter.source = req.query.source;       // 'auto'|'pixel'|'postback'|'api'
  if (req.query.event) filter.event_name = req.query.event;
  if (req.query.auto === '1') filter.auto_detected = true;

  // Optional date range filter
  if (req.query.from || req.query.to) {
    filter.ts = {};
    if (req.query.from) filter.ts.$gte = new Date(req.query.from);
    if (req.query.to) {
      // Treat 'to' as end-of-day inclusive
      const t = new Date(req.query.to);
      t.setHours(23, 59, 59, 999);
      filter.ts.$lte = t;
    }
  }

  const conversions = await Conversion.find(filter)
    .sort({ ts: -1 })
    .limit(200)
    .populate('campaign_id', 'name slug')
    .lean();

  // Hydrate each conversion with key click + page details so the table can show them
  // without a join in the view. We do this in one batched query for efficiency.
  const clickIds = Array.from(new Set(conversions.map((c) => c.click_id)));
  const clicks = clickIds.length
    ? await Click.find({ workspace_id: ws._id, click_id: { $in: clickIds } })
        .select('click_id ip country country_name asn_org organisation ua_parsed in_app_browser is_proxy proxy_type ip_type page_rendered landing_page_id ts utm')
        .populate('landing_page_id', 'name slug')
        .lean()
    : [];
  const clickMap = Object.fromEntries(clicks.map((c) => [c.click_id, c]));
  conversions.forEach((c) => { c.click = clickMap[c.click_id] || null; });

  // Dropdown data
  const campaigns = await Campaign.find({ workspace_id: ws._id }).select('name slug').lean();

  // Aggregate counters - shown above the table
  const totalCount = conversions.length;
  const autoCount = conversions.filter((c) => c.auto_detected).length;
  const totalValue = conversions.reduce((s, c) => s + (Number(c.value) || 0), 0);

  res.render('admin/conversions', {
    ws,
    conversions,
    campaigns,
    query: req.query,
    stats: { totalCount, autoCount, totalValue },
    page: 'conversions',
  });
});

// CSV export of the same filtered conversions
router.get('/conversions.csv', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = { workspace_id: ws._id };
  if (req.query.campaign) filter.campaign_id = req.query.campaign;
  if (req.query.source) filter.source = req.query.source;
  if (req.query.event) filter.event_name = req.query.event;
  if (req.query.auto === '1') filter.auto_detected = true;
  if (req.query.from || req.query.to) {
    filter.ts = {};
    if (req.query.from) filter.ts.$gte = new Date(req.query.from);
    if (req.query.to) {
      const t = new Date(req.query.to);
      t.setHours(23, 59, 59, 999);
      filter.ts.$lte = t;
    }
  }

  const conversions = await Conversion.find(filter)
    .sort({ ts: -1 })
    .limit(10000)         // higher limit for export, still capped
    .populate('campaign_id', 'name slug')
    .lean();

  const clickIds = Array.from(new Set(conversions.map((c) => c.click_id)));
  const clicks = clickIds.length
    ? await Click.find({ workspace_id: ws._id, click_id: { $in: clickIds } })
        .select('click_id ip country asn_org page_rendered utm')
        .lean()
    : [];
  const clickMap = Object.fromEntries(clicks.map((c) => [c.click_id, c]));

  const headers = [
    'ts', 'click_id', 'campaign', 'campaign_slug',
    'event_name', 'source', 'auto_detected', 'value', 'currency',
    'matched_term', 'matched_text', 'matched_element', 'page_url',
    'ip', 'country', 'provider',
    'utm_source', 'utm_medium', 'utm_campaign',
  ];
  const rows = [headers.join(',')];
  for (const c of conversions) {
    const click = clickMap[c.click_id] || {};
    rows.push([
      c.ts ? new Date(c.ts).toISOString() : '',
      c.click_id,
      c.campaign_id?.name || '',
      c.campaign_id?.slug || '',
      c.event_name || '',
      c.source || '',
      c.auto_detected ? 'true' : 'false',
      c.value ?? 0,
      c.currency || 'USD',
      c.matched_term || '',
      c.matched_text || '',
      c.matched_element || '',
      c.page_url || '',
      click.ip || '',
      click.country || '',
      click.asn_org || '',
      click.utm?.source || '',
      click.utm?.medium || '',
      click.utm?.campaign || '',
    ].map(csvEscape).join(','));
  }

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="conversions-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(rows.join('\n'));
});

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Quote if contains comma, quote, or newline
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

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

// ---------- Site pages (homepage, privacy, terms, etc.) ----------
router.get('/site', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const pages = await SitePage.find({ workspace_id: ws._id }).sort({ slug: 1 }).lean();
  // Pre-load the well-known slugs even if they don't exist yet, so the UI shows them
  const knownSlugs = ['home', 'privacy', 'terms', '404'];
  const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]));
  const enriched = knownSlugs
    .map((slug) => bySlug[slug] || { slug, title: '', html: '', enabled: false, _placeholder: true })
    .concat(pages.filter((p) => !knownSlugs.includes(p.slug)));
  res.render('admin/site', { ws, pages: enriched, page: 'site' });
});

router.get('/site/:slug/edit', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const slug = String(req.params.slug || '').toLowerCase();
  let sp = await SitePage.findOne({ workspace_id: ws._id, slug }).lean();
  if (!sp) {
    sp = { slug, title: '', html: '', enabled: true, meta: {}, _new: true };
  }
  res.render('admin/site_form', { ws, sp, page: 'site' });
});

router.post('/site/:slug', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const slug = String(req.params.slug || '').toLowerCase().trim();
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).send('Invalid slug');

  const body = req.body || {};
  const update = {
    title: body.title || '',
    html: body.html || '',
    enabled: body.enabled === 'on' || body.enabled === 'true',
    meta: {
      description: body.meta_description || '',
      og_image: body.meta_og_image || '',
      noindex: body.meta_noindex === 'on',
    },
  };

  await SitePage.updateOne(
    { workspace_id: ws._id, slug },
    { $set: update, $setOnInsert: { workspace_id: ws._id, slug, created_at: new Date() } },
    { upsert: true }
  );
  res.redirect('/admin/site');
});

router.post('/site/:slug/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const slug = String(req.params.slug || '').toLowerCase();
  await SitePage.deleteOne({ workspace_id: ws._id, slug });
  res.redirect('/admin/site');
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
