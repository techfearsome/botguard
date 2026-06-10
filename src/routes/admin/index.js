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
const { parseRange, applyRangeToFilter, RANGE_OPTIONS } = require('../../lib/dateRange');
const { validateRootPath } = require('../../lib/reservedPaths');
const { renderPreview, setPreviewHeaders, PREVIEW_PLACEHOLDERS } = require('../../lib/preview');

/**
 * Best-effort cache invalidation for the dynamic robots.txt and sitemap.xml.
 * Called by admin handlers that mutate campaigns or site pages so changes are
 * visible to crawlers on the next /robots.txt or /sitemap.xml request rather
 * than waiting for the in-memory TTL to expire.
 *
 * Lazily-required to avoid a circular dependency (site.js requires admin code
 * indirectly via the cache module).
 */
function invalidateRobotsCache() {
  try {
    const siteRoutes = require('../site');
    if (typeof siteRoutes.clearRobotsCache === 'function') siteRoutes.clearRobotsCache();
  } catch (e) { /* ignore - best-effort */ }
}
function invalidateSitemapCache() {
  try {
    const siteRoutes = require('../site');
    if (typeof siteRoutes.clearSitemapCache === 'function') siteRoutes.clearSitemapCache();
  } catch (e) { /* ignore - best-effort */ }
}

// --- Login / logout (must be defined BEFORE requireAdmin gate) ---
router.get('/login', loginPage);
router.post('/login', loginSubmit);
router.get('/logout', logout);

// --- Cloudflare Worker log API (BEFORE requireAdmin) ---
// The Worker authenticates with CF_SYNC_KEY, not admin sessions.
// Must be mounted before the requireAdmin gate or the Worker gets 401.
router.post('/cloudflare/api/log', async (req, res) => {
  const syncKey = process.env.CF_SYNC_KEY;
  if (!syncKey) return res.status(503).json({ error: 'CF_SYNC_KEY not set' });

  const key = req.headers['x-botguard-key'];
  if (!key || key !== syncKey) return res.status(401).json({ error: 'unauthorized' });

  const CloudflareLog = require('../../models/CloudflareLog');

  // Get workspace (single-tenant: just grab the first one)
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

// --- Everything below this gate requires authentication ---
router.use(requireAdmin);

// Admin pages must never be cached (would leak session-specific data via shared CDN cache)
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.set('CDN-Cache-Control', 'no-store');
  next();
});

// Mount Cloudflare edge firewall routes
const cloudflareRoutes = require('./cloudflare');
router.use('/cloudflare', cloudflareRoutes);

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
  // "Today" = since midnight server-local. Used for the Recent Clicks list
  // so the dashboard shows what's relevant right now, not stale history.
  const sinceToday = new Date(); sinceToday.setHours(0, 0, 0, 0);

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
    Click.find({ workspace_id: ws._id, ts: { $gte: sinceToday } })
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
    recentClicksScope: 'today',
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
  res.render('admin/campaign_form', { ws, campaign: null, pages, baseUrl: process.env.BASE_URL || '', page: 'campaigns' });
});

router.post('/campaigns', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  try {
    // Auto-resolve slug from name if not provided, append digits on collision
    const slug = await resolveSlug(body.slug, body.name, async (s) => {
      return !!(await Campaign.exists({ workspace_id: ws._id, slug: s }));
    });

    // Validate optional custom root path. Empty string is fine - means
    // the campaign is only reachable at /go/<slug>.
    const rootPathResult = validateRootPath(body.root_path);
    if (!rootPathResult.valid) {
      return res.status(400).send(`Custom URL path: ${rootPathResult.error}`);
    }
    // Check uniqueness within the workspace if non-empty
    if (rootPathResult.normalized) {
      const collision = await Campaign.exists({
        workspace_id: ws._id,
        root_path: rootPathResult.normalized,
      });
      if (collision) {
        return res.status(400).send(`Custom URL path "/${rootPathResult.normalized}" is already used by another campaign in this workspace.`);
      }
    }

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
      root_path: rootPathResult.normalized,
      name: body.name,
      status: body.status || 'active',
      indexable: body.indexable === 'on' || body.indexable === 'true',
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
      residential_proxy_detection: body.residential_proxy_enabled === 'on',
      residential_proxy: {
        enabled: body.residential_proxy_enabled === 'on',
        provider: body.residential_proxy_provider || 'auto',
      },
      notes: body.notes || '',
    });
    // New campaigns may have added a custom root_path - the next /robots.txt
    // request must include the new Disallow rule. Invalidating the cache here
    // makes that visible without waiting for the 5-minute TTL. Same for
    // /sitemap.xml: indexable campaigns appear there.
    invalidateRobotsCache();
    invalidateSitemapCache();
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
  res.render('admin/campaign_form', { ws, campaign, pages, baseUrl: process.env.BASE_URL || '', page: 'campaigns' });
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

    // Validate optional custom root path. Allow keeping the existing one
    // unchanged without re-checking uniqueness against itself.
    const rootPathResult = validateRootPath(body.root_path);
    if (!rootPathResult.valid) {
      return res.status(400).send(`Custom URL path: ${rootPathResult.error}`);
    }
    if (rootPathResult.normalized && rootPathResult.normalized !== existing.root_path) {
      const collision = await Campaign.exists({
        workspace_id: ws._id,
        root_path: rootPathResult.normalized,
        _id: { $ne: existing._id },
      });
      if (collision) {
        return res.status(400).send(`Custom URL path "/${rootPathResult.normalized}" is already used by another campaign in this workspace.`);
      }
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
          root_path: rootPathResult.normalized,
          name: body.name,
          status: body.status,
          indexable: body.indexable === 'on' || body.indexable === 'true',
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
          residential_proxy_detection: body.residential_proxy_enabled === 'on',
          'residential_proxy.enabled': body.residential_proxy_enabled === 'on',
          'residential_proxy.provider': body.residential_proxy_provider || 'auto',
          notes: body.notes || '',
        },
      }
    );
    // Invalidate both old and new slug to handle slug renames
    await cache.invalidateCampaign(ws._id, existing.slug);
    if (slug !== existing.slug) await cache.invalidateCampaign(ws._id, slug);
    // root_path may have been added/removed/changed - refresh /robots.txt.
    // indexable status may have flipped - refresh /sitemap.xml too.
    invalidateRobotsCache();
    invalidateSitemapCache();
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
  // Deleted campaign may have had a root_path - drop it from /robots.txt.
  // It may have been indexable - drop it from /sitemap.xml too.
  invalidateRobotsCache();
  invalidateSitemapCache();
  res.redirect('/admin/campaigns');
});

/**
 * Quick toggle for campaign on/off without opening the edit form.
 * Flips between 'active' and 'paused'. 'archived' campaigns are left alone -
 * the admin must explicitly un-archive via the form.
 *
 * Cache invalidation matters here: the /go hot path caches the campaign
 * doc for 60s. Without this invalidation, the toggle wouldn't take effect
 * for up to a minute. With it, next request sees the new status.
 */
router.post('/campaigns/:id/toggle', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const camp = await Campaign.findOne({ _id: req.params.id, workspace_id: ws._id })
    .select('slug status')
    .lean();
  if (!camp) return res.status(404).send('Campaign not found');

  // Only flip between active <-> paused. Archived campaigns stay archived
  // until explicitly changed via the full form.
  let newStatus;
  if (camp.status === 'active') newStatus = 'paused';
  else if (camp.status === 'paused') newStatus = 'active';
  else return res.redirect('/admin/campaigns');     // archived: no-op

  await Campaign.updateOne(
    { _id: req.params.id, workspace_id: ws._id },
    { $set: { status: newStatus, updated_at: new Date() } }
  );
  await cache.invalidateCampaign(ws._id, camp.slug);
  logger.info('campaign_status_toggled', {
    campaign_id: String(req.params.id),
    slug: camp.slug,
    from: camp.status,
    to: newStatus,
  });
  res.redirect('/admin/campaigns');
});

/**
 * Preview the rendered HTML for a campaign — useful for verifying that the auto-conversion
 * script and Clarity tag are actually being injected.
 *
 * Returns plain text so the admin can scroll through the source. Does NOT log a click,
 * does NOT set cookies, does NOT run filters. It's purely a "what would I serve" view.
 *
 * To peek at safe page: ?kind=safe
 * To pretend to be a specific device: ?device=iphone (or android/windows/mac/linux/other)
 */
router.get('/campaigns/:id/preview', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const campaign = await Campaign.findOne({ _id: req.params.id, workspace_id: ws._id }).lean();
  if (!campaign) return res.status(404).send('Campaign not found');

  const kind = req.query.kind === 'safe' ? 'safe' : 'offer';
  const device = ['iphone','android','windows','mac','linux','other'].includes(req.query.device)
    ? req.query.device : 'other';

  const { resolvePageForDevice } = require('../../lib/pageResolver');
  const { buildInjection } = require('../../lib/autoConversion');
  const { buildTrackingInjection } = require('../../lib/tracking');

  const page = await resolvePageForDevice(campaign, device, kind);
  if (!page) {
    return res.type('text/plain').send(`No ${kind} page configured for device class "${device}".\nFalls back to the built-in stub at request time.`);
  }

  let html = page.html_template || (page.variants?.[0]?.html) || '';

  // Apply same injections /go would
  if (kind === 'offer' && page.auto_conversion?.enabled) {
    const injection = buildInjection({
      terms: page.auto_conversion.terms,
      eventName: page.auto_conversion.event_name || 'auto_click',
    });
    const idx = html.search(/<\/body\s*>/i);
    html = idx >= 0 ? html.slice(0, idx) + injection + html.slice(idx) : html + injection;
  }
  const trackingId = ws.settings?.tracking?.clarity_project_id;
  if (trackingId) {
    const injection = buildTrackingInjection({ clarityProjectId: trackingId });
    const idx = html.search(/<\/body\s*>/i);
    html = idx >= 0 ? html.slice(0, idx) + injection + html.slice(idx) : html + injection;
  }

  // Render as plain text so the admin can scroll through the source easily
  res.type('text/plain; charset=utf-8').send(
    `=== Preview: campaign="${campaign.slug}", kind=${kind}, device=${device}\n` +
    `=== Page: "${page.name}" (slug: ${page.slug})\n` +
    `=== auto_conversion.enabled: ${!!page.auto_conversion?.enabled}\n` +
    `=== Clarity project ID: ${trackingId || '(not set)'}\n` +
    `=== HTML length: ${html.length} bytes\n` +
    `=== Auto-conv script present: ${html.includes('bg-auto-conv-config') ? 'YES' : 'NO'}\n` +
    `=== Clarity script present: ${html.includes('clarity.ms/tag') ? 'YES' : 'NO'}\n` +
    `\n${'='.repeat(72)}\n\n` +
    html
  );
});

/**
 * Visitor-rendered preview for a campaign's offer or safe page.
 * Returns rendered HTML (text/html), unlike /campaigns/:id/preview which
 * returns the source for inspection. No tracking, no logging, no cookies.
 *
 * GET /admin/campaigns/:id/preview/page/:kind  (kind = "offer" or "safe")
 * Optional: ?device=iphone|android|windows|mac|linux|other (default 'other')
 */
router.get('/campaigns/:id/preview/page/:kind', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const campaign = await Campaign.findOne({ _id: req.params.id, workspace_id: ws._id }).lean();
  if (!campaign) return res.status(404).send('Campaign not found');

  const kind = req.params.kind === 'safe' ? 'safe' : 'offer';
  const device = ['iphone','android','windows','mac','linux','other'].includes(req.query.device)
    ? req.query.device : 'other';

  const { resolvePageForDevice } = require('../../lib/pageResolver');
  const page = await resolvePageForDevice(campaign, device, kind);
  if (!page) {
    setPreviewHeaders(res);
    return res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;max-width:600px;margin:0 auto;"><h2>No ${kind} page configured</h2><p>This campaign has no ${kind} page set for device class "${device}". A real visit would render the built-in stub.</p></body></html>`);
  }

  setPreviewHeaders(res);
  res.send(renderPreview(page));
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

/**
 * Visitor-rendered preview of a saved LandingPage.
 * Returns rendered HTML with placeholders interpolated, WP fingerprint
 * meta injected, but NO tracking, NO Click row, NO cookies, NO filter chain.
 * The ?utm_source=... etc query parameters can be passed to override the
 * default "preview" placeholder values for testing UTM-driven content.
 */
router.get('/pages/:id/preview', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const page = await LandingPage.findOne({ _id: req.params.id, workspace_id: ws._id }).lean();
  if (!page) return res.status(404).send('Page not found');

  // Allow query-string overrides for placeholder values - useful for testing
  // landing pages that use {{utm_source}} etc to display dynamic content.
  // We only override values that were explicitly provided so unset query
  // params keep the friendly "preview" defaults.
  const placeholders = { ...PREVIEW_PLACEHOLDERS };
  for (const k of ['click_id', 'utm_source', 'utm_medium', 'utm_campaign']) {
    if (typeof req.query[k] === 'string' && req.query[k]) {
      placeholders[k] = req.query[k];
    }
  }

  setPreviewHeaders(res);
  res.send(renderPreview(page, { placeholders }));
});

// ---------- Live presence ----------
const { live } = require('../../lib/livePresence');

router.get('/live', async (req, res) => {
  const ws = await resolveWorkspace(req);
  // Seed the daily-conversion counter from DB so the dashboard shows accurate
  // "Conversions today" from minute one (not just conversions-since-server-start).
  await live.seedDailyFromDb(ws._id, Conversion);
  const snapshot = live.snapshot(ws._id);
  res.render('admin/live', { ws, snapshot, page: 'live' });
});

/**
 * Server-Sent Events stream of live presence events.
 *
 * The dashboard client opens an EventSource('/admin/live/stream') and receives
 * real-time push events as visitors arrive, heartbeat, convert, or leave.
 *
 * SSE chosen over Socket.io because:
 *   - One-way is enough (server -> admin)
 *   - Plain HTTP works through Cloudflare without WebSockets enabled
 *   - Native EventSource auto-reconnects on disconnect
 *   - No client library needed
 *
 * Events are filtered to the admin's workspace.
 *
 * Event types:
 *   - snapshot:    initial state on connection
 *   - arrived:     new visitor on a /go page
 *   - updated:     re-arrived (re-render of same click_id)
 *   - heartbeat:   visitor still active
 *   - converted:   visitor clicked a tracked button
 *   - left:        visitor's tab closed or went stale
 *   - daily_stats: per-workspace daily conversion counter changed
 */
router.get('/live/stream', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const wsId = String(ws._id);

  // Make sure the daily counter is seeded for this workspace - otherwise an
  // admin who lands on /admin/live AFTER conversions for the day already
  // happened would see a stale 0 until the next conversion fires.
  await live.seedDailyFromDb(ws._id, Conversion);

  // SSE headers. Critically, no Cache-Control caching since this is a long-lived
  // connection. X-Accel-Buffering off prevents nginx from buffering the stream.
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Send the current snapshot first - so a freshly-opened dashboard doesn't
  // start empty waiting for new arrivals.
  function send(eventName, data) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  send('snapshot', live.snapshot(wsId));

  // Subscribe to per-visitor events. Filter by workspace.
  function onEvent(payload) {
    if (!payload || !payload.visitor) return;
    if (payload.visitor.workspace_id && String(payload.visitor.workspace_id) !== wsId) return;
    send(payload.type, payload.visitor);
  }
  live.on('event', onEvent);

  // Subscribe to daily stats events. Forward only the bucket that matches this
  // admin's workspace (so admins of workspace A never see workspace B's counter).
  function onDailyStats(payload) {
    if (!payload) return;
    if (String(payload.workspace_id) !== wsId) return;
    send('daily_stats', payload);
  }
  live.on('daily_stats', onDailyStats);

  // Keep-alive comment every 25s. Without this, intermediate proxies (Cloudflare,
  // nginx) may close the connection after 60-90s of silence, even though SSE
  // is supposed to be long-lived.
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(keepalive);
    live.removeListener('event', onEvent);
    live.removeListener('daily_stats', onDailyStats);
  });
});

// ---------- Click log ----------
/**
 * Build the Mongo filter for the clicks list. Used by both `GET /clicks`
 * (renders the admin view, capped at 200 rows) and `GET /clicks.csv`
 * (exports the same filtered set, capped higher). Sharing this guarantees
 * the export contains exactly the rows the admin was looking at, not a
 * different subset because of a copy-paste drift between two query builders.
 *
 * Note that the caller still applies the date range separately via
 * applyRangeToFilter() because parseRange() needs the req.query directly.
 */
function buildClicksFilter(req, ws) {
  const filter = { workspace_id: ws._id };
  if (req.query.campaign) filter.campaign_id = req.query.campaign;
  if (req.query.decision) filter.decision = req.query.decision;
  if (req.query.source) filter['utm.source'] = req.query.source;

  // Click-ID search: try the value against all five ad-platform identifiers
  // simultaneously. Useful when debugging "did Google ever send us a click
  // with this gclid?" without the admin having to know which platform's
  // identifier it is. Case-sensitive match - these IDs are case-sensitive.
  if (req.query.click_id && typeof req.query.click_id === 'string') {
    const cid = req.query.click_id.trim();
    if (cid) {
      filter.$or = [
        { 'external_ids.gclid':   cid },
        { 'external_ids.wbraid':  cid },
        { 'external_ids.gbraid':  cid },
        { 'external_ids.fbclid':  cid },
        { 'external_ids.msclkid': cid },
      ];
    }
  }
  return filter;
}

router.get('/clicks', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = buildClicksFilter(req, ws);

  // Default range = "today" (controlled by ?range=today|yesterday|7d|30d|all|custom)
  const range = parseRange(req.query);
  applyRangeToFilter(filter, range);

  // Pagination - replaces the previous hard 200-row cap which silently
  // hid most of the day's traffic on busy workspaces. Page number is
  // 1-indexed (more natural for humans than 0). Page size capped at 500
  // to keep the query bounded; admins who want more should use CSV export
  // which is built for bulk.
  const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];
  const requestedPerPage = parseInt(req.query.per, 10);
  const perPage = PAGE_SIZE_OPTIONS.includes(requestedPerPage) ? requestedPerPage : 100;
  const requestedPage = parseInt(req.query.page_n, 10);
  const pageNum = (Number.isFinite(requestedPage) && requestedPage >= 1) ? requestedPage : 1;
  const skip = (pageNum - 1) * perPage;

  // countDocuments() runs alongside find() - Mongo's (workspace_id, ts)
  // index covers both, so this is a single index scan. At ~thousands of
  // clicks/day this completes in under 10ms; we revisit if we ever see
  // workspaces with millions of total clicks.
  const [clicks, totalCount] = await Promise.all([
    Click.find(filter)
      .sort({ ts: -1 })
      .skip(skip)
      .limit(perPage)
      .populate('campaign_id', 'name slug')
      .lean(),
    Click.countDocuments(filter),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));

  const campaigns = await Campaign.find({ workspace_id: ws._id }).select('name slug').lean();

  res.render('admin/clicks', {
    ws, clicks, campaigns,
    query: req.query,
    range,
    rangeOptions: RANGE_OPTIONS,
    // Note: `page` is reserved for the nav-active key. Use distinct names
    // for the pagination state so the template doesn't get confused.
    currentPage: pageNum,
    totalPages,
    totalCount,
    perPage,
    perPageOptions: PAGE_SIZE_OPTIONS,
    showingFrom: totalCount === 0 ? 0 : skip + 1,
    showingTo: Math.min(skip + perPage, totalCount),
    page: 'clicks',
  });
});

/**
 * CSV export of the clicks list with the same filters applied as the list
 * view. Higher row cap (10K) than the list (200) since the whole point is
 * offline analysis. Columns chosen to be useful for spreadsheet pivots and
 * ad-platform conversion debugging without bloating the file - includes all
 * five external click identifiers (gclid, wbraid, gbraid, fbclid, msclkid)
 * so admins can grep for a specific platform's click to investigate
 * attribution issues.
 */
router.get('/clicks.csv', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = buildClicksFilter(req, ws);

  // Same range semantics as /clicks - parseRange() reads req.query directly,
  // so the same query string produces the same range here.
  const range = parseRange(req.query);
  applyRangeToFilter(filter, range);

  const clicks = await Click.find(filter)
    .sort({ ts: -1 })
    .limit(10000)               // higher cap for export, still bounded
    .populate('campaign_id', 'name slug')
    .lean();

  const headers = [
    'ts',                       // ISO timestamp
    'click_id',                 // our internal click ID
    'campaign', 'campaign_slug',
    'decision', 'decision_reason',
    'page_rendered', 'variant_shown',
    'risk_score',
    'ip', 'country', 'asn', 'asn_org',
    'device_class', 'device_label', 'os', 'browser', 'browser_version',
    'in_app_browser',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    // All five ad-platform click identifiers. wbraid/gbraid are the iOS
    // privacy-preserving aggregate IDs that Apple sends instead of gclid
    // for ATT-restricted traffic. Including them as separate columns lets
    // admins pivot/filter by platform when debugging attribution.
    'gclid', 'wbraid', 'gbraid', 'fbclid', 'msclkid',
    // Google Ads ValueTrack - the high-signal subset of the 29 parameters
    // we capture. Skipping the shopping/travel ones (rare for most
    // advertisers) and the geo-target IDs (numeric, not human-useful in a
    // spreadsheet without a lookup table). The full set is still in
    // click.valuetrack.google and visible on the click-detail page.
    'g_campaignid', 'g_adgroupid', 'g_creative',
    'g_keyword', 'g_matchtype', 'g_network', 'g_device', 'g_placement',
    'referer',
    'user_agent',
    'conversion_count',
  ];
  const rows = [headers.join(',')];
  for (const c of clicks) {
    rows.push([
      c.ts ? new Date(c.ts).toISOString() : '',
      c.click_id,
      c.campaign_id?.name || '',
      c.campaign_id?.slug || '',
      c.decision || '',
      c.decision_reason || '',
      c.page_rendered || '',
      c.variant_shown || '',
      c.scores?.total ?? '',
      c.ip || '',
      c.country || '',
      c.asn ?? '',
      c.asn_org || '',
      c.device_class || '',
      c.ua_parsed?.device_label || '',
      c.ua_parsed?.os || '',
      c.ua_parsed?.browser || '',
      c.ua_parsed?.browser_version || '',
      c.in_app_browser || '',
      c.utm?.source || '',
      c.utm?.medium || '',
      c.utm?.campaign || '',
      c.utm?.term || '',
      c.utm?.content || '',
      c.external_ids?.gclid   || '',
      c.external_ids?.wbraid  || '',
      c.external_ids?.gbraid  || '',
      c.external_ids?.fbclid  || '',
      c.external_ids?.msclkid || '',
      c.valuetrack?.google?.campaignid || '',
      c.valuetrack?.google?.adgroupid  || '',
      c.valuetrack?.google?.creative   || '',
      c.valuetrack?.google?.keyword    || '',
      c.valuetrack?.google?.matchtype  || '',
      c.valuetrack?.google?.network    || '',
      c.valuetrack?.google?.device     || '',
      c.valuetrack?.google?.placement  || '',
      c.referer || '',
      c.user_agent || '',
      c.conversion_count ?? 0,
    ].map(csvEscape).join(','));
  }

  // Filename includes the date range for self-describing downloads when the
  // admin's been doing several exports.
  const today = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="clicks-${today}.csv"`);
  // CRLF line endings - more compatible with Windows tools (Excel) and
  // matches the pattern used by /admin/firewall/export.csv.
  res.send(rows.join('\r\n') + '\r\n');
});

// ---------- Conversions ----------
router.get('/conversions', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = { workspace_id: ws._id };

  if (req.query.campaign) filter.campaign_id = req.query.campaign;
  if (req.query.source) filter.source = req.query.source;       // 'auto'|'pixel'|'postback'|'api'
  if (req.query.event) filter.event_name = req.query.event;
  if (req.query.auto === '1') filter.auto_detected = true;

  // Default range = "today". Backwards-compat: if old links pass ?from= or ?to=,
  // treat them as a custom range. New links should use ?range=custom&date_from=&date_to=.
  let range;
  if ((req.query.from || req.query.to) && !req.query.range) {
    range = parseRange({ range: 'custom', date_from: req.query.from, date_to: req.query.to });
  } else {
    range = parseRange(req.query);
  }
  applyRangeToFilter(filter, range);

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
    range,
    rangeOptions: RANGE_OPTIONS,
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

  // Same range parsing as /conversions for consistency
  let range;
  if ((req.query.from || req.query.to) && !req.query.range) {
    range = parseRange({ range: 'custom', date_from: req.query.from, date_to: req.query.to });
  } else {
    range = parseRange(req.query);
  }
  applyRangeToFilter(filter, range);

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
      asn_org: ruleType === 'cidr'
        ? String(body.cidr_label || '').trim()
        : String(Array.isArray(body.asn_org) ? body.asn_org[0] : (body.asn_org || '')).trim(),
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
    } else if (ruleType === 'cidr') {
      let value = (body.cidr || '').trim();
      if (!value) throw new Error('IP or CIDR range is required');
      // Auto-detect and normalize format
      if (value.includes('*')) {
        // Wildcard → CIDR: 47.144.3.* → 47.144.3.0/24
        value = value.replace('.*', '.0/24');
      } else if (!value.includes('/')) {
        // Single IP → add prefix length
        if (value.includes(':')) {
          value = value + '/128';   // IPv6 single
        } else {
          value = value + '/32';    // IPv4 single
        }
      }
      doc.cidr = value;
      // Check for duplicate
      const existsQ = { cidr: value };
      if (doc.workspace_id) existsQ.workspace_id = doc.workspace_id;
      else existsQ.workspace_id = null;
      if (await AsnBlacklist.findOne(existsQ)) throw new Error('This IP/CIDR rule already exists');
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

// ---------- Firewall (flagged-IP ledger) ----------
//
// One row per unique flagged IP, with hit count + reasons accumulated over
// time. Sourced automatically from the click write path - any block decision
// that classifies as a fraud signal (proxy, VPN, datacenter, bot, ASN,
// hard-block, source mismatch) creates or updates a FirewallEntry row.
//
// Date range filter follows the same pattern as conversions / clicks (uses
// last_seen for "what got hit recently").
//
// CSV export at /admin/firewall/export.csv is shaped for Google Ads IP
// exclusion - one IP per line, capped at 500 rows by default (Google Ads
// per-list limit). Admins can also download a richer CSV (with reasons,
// device, dates) at /admin/firewall/full.csv for AbuseIPDB / manual review.

const { FirewallEntry } = require('../../models');

function buildFirewallFilter(req, ws) {
  const filter = { workspace_id: ws._id };

  // Reason class filter - multi-select. ?class=proxy,bot returns either.
  if (req.query.class && typeof req.query.class === 'string') {
    const classes = req.query.class.split(',').map((s) => s.trim()).filter(Boolean);
    if (classes.length) filter.reason_classes = { $in: classes };
  }

  // Reviewed filter - default hides reviewed entries (admin already saw them)
  // unless ?reviewed=all or ?reviewed=1
  if (req.query.reviewed === '1') filter.reviewed = true;
  else if (req.query.reviewed === 'all') { /* no filter - show both */ }
  else filter.reviewed = false;

  // Free-text search over IP / ASN / country
  if (req.query.q && typeof req.query.q === 'string') {
    const q = req.query.q.trim();
    if (q) {
      filter.$or = [
        { ip: q },                                     // exact IP match
        { last_asn: new RegExp(q, 'i') },
        { last_country: new RegExp('^' + q + '$', 'i') },
      ];
    }
  }

  return filter;
}

router.get('/firewall', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = buildFirewallFilter(req, ws);

  // Date range applied to last_seen (when did we last see this IP)
  const range = parseRange(req.query);
  if (range && range.from) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$gte = range.from;
  }
  if (range && range.to) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$lte = range.to;
  }

  const entries = await FirewallEntry.find(filter)
    .sort({ last_seen: -1 })
    .limit(500)
    .lean();

  // Aggregate reason-class counts for the filter UI
  const counts = await FirewallEntry.aggregate([
    { $match: { workspace_id: ws._id, reviewed: false } },
    { $unwind: '$reason_classes' },
    { $group: { _id: '$reason_classes', count: { $sum: 1 } } },
  ]);
  const classCounts = Object.fromEntries(counts.map((c) => [c._id, c.count]));

  res.render('admin/firewall', {
    ws,
    page: 'firewall',
    entries,
    range,
    rangeOptions: RANGE_OPTIONS,
    classCounts,
    classes: FirewallEntry.REASON_CLASSES,
    activeClasses: req.query.class ? req.query.class.split(',') : [],
    showReviewed: req.query.reviewed,
    searchQuery: req.query.q || '',
  });
});

/**
 * Mark entries as reviewed (or un-reviewed). Body: ids=<id1>,<id2>,...
 * Used to clear flagged IPs out of the default view after exporting them.
 */
router.post('/firewall/mark-reviewed', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const ids = String(req.body.ids || '').split(',').filter(Boolean);
  const reviewed = req.body.reviewed !== '0';
  if (ids.length) {
    await FirewallEntry.updateMany(
      { _id: { $in: ids }, workspace_id: ws._id },
      { $set: { reviewed } }
    );
  }
  res.redirect('back');
});

/**
 * Mark ALL currently-visible entries as reviewed. Same filters as the list
 * view so "review all" only affects what the admin actually sees.
 */
router.post('/firewall/mark-all-reviewed', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = buildFirewallFilter(req, ws);
  // Range filter from the list view
  const range = parseRange(req.body);
  if (range && range.from) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$gte = range.from;
  }
  if (range && range.to) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$lte = range.to;
  }
  await FirewallEntry.updateMany(filter, { $set: { reviewed: true } });
  res.redirect('/admin/firewall');
});

router.post('/firewall/:id/notes', async (req, res) => {
  const ws = await resolveWorkspace(req);
  await FirewallEntry.updateOne(
    { _id: req.params.id, workspace_id: ws._id },
    { $set: { notes: String(req.body.notes || '').slice(0, 500) } }
  );
  res.redirect('/admin/firewall');
});

router.post('/firewall/:id/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  await FirewallEntry.deleteOne({ _id: req.params.id, workspace_id: ws._id });
  res.redirect('/admin/firewall');
});

/**
 * CSV export for Google Ads IP exclusion list. One IP per line, no header,
 * capped at 500 rows by default (Google Ads per-list limit). Filters from
 * the URL query are honored so admins can export "last 7 days, proxy only".
 */
router.get('/firewall/export.csv', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = buildFirewallFilter(req, ws);

  const range = parseRange(req.query);
  if (range && range.from) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$gte = range.from;
  }
  if (range && range.to) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$lte = range.to;
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const entries = await FirewallEntry.find(filter)
    .sort({ last_seen: -1 })
    .limit(limit)
    .select('ip')
    .lean();

  // Plain CSV - one IP per line. No header (Google Ads doesn't expect one).
  // We deliberately use \r\n line endings since some upload tools (including
  // older Google Ads bulk uploaders) get cranky with bare \n.
  const csv = entries.map((e) => e.ip).join('\r\n') + (entries.length ? '\r\n' : '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="firewall-ips-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

/**
 * Rich CSV export - includes reason, hit count, dates, country, ASN, device.
 * Useful for AbuseIPDB submission review or manual analysis. NOT shaped for
 * Google Ads (which only wants the IP column).
 */
router.get('/firewall/full.csv', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const filter = buildFirewallFilter(req, ws);

  const range = parseRange(req.query);
  if (range && range.from) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$gte = range.from;
  }
  if (range && range.to) {
    filter.last_seen = filter.last_seen || {};
    filter.last_seen.$lte = range.to;
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 50000);
  const entries = await FirewallEntry.find(filter)
    .sort({ last_seen: -1 })
    .limit(limit)
    .lean();

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const lines = [
    ['ip', 'reason_classes', 'reasons', 'hit_count', 'first_seen', 'last_seen', 'country', 'asn', 'device', 'campaign', 'user_agent', 'notes'].join(','),
  ];
  for (const e of entries) {
    lines.push([
      csvCell(e.ip),
      csvCell((e.reason_classes || []).join('|')),
      csvCell((e.reasons || []).join('|')),
      csvCell(e.hit_count || 0),
      csvCell(e.first_seen ? new Date(e.first_seen).toISOString() : ''),
      csvCell(e.last_seen ? new Date(e.last_seen).toISOString() : ''),
      csvCell(e.last_country || ''),
      csvCell(e.last_asn || ''),
      csvCell(e.last_device || ''),
      csvCell(e.last_campaign_slug || ''),
      csvCell(e.last_user_agent || ''),
      csvCell(e.notes || ''),
    ].join(','));
  }

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="firewall-full-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\r\n') + '\r\n');
});

// ---------- CIDR Intelligence (bot subnet detection) ----------

const CidrIntelligence = require('../../models/CidrIntelligence');
const CloudflareRule = require('../../models/CloudflareRule');

// Summary endpoint — polled every 30s by the live view for new detections.
//
// 'newCount' counts CIDRs that were touched by the worker in the recent window
// AND meet the score threshold. We use last_seen (set explicitly by the worker
// to the analysis-end time) rather than mongoose's updatedAt, because every
// 60s worker pass updates every doc — so updatedAt-based queries always return
// the entire watching set, which is uninformative.
router.get('/intelligence/summary', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 5 * 60 * 1000);

  const [newCount, criticalCount, totalActive, watchlistCount] = await Promise.all([
    CidrIntelligence.countDocuments({
      workspace_id: ws._id,
      status: 'new',
      score: { $gte: 40 },
      last_seen: { $gte: since },
    }),
    CidrIntelligence.countDocuments({
      workspace_id: ws._id,
      status: 'new',
      score: { $gte: 80 },
    }),
    CidrIntelligence.countDocuments({
      workspace_id: ws._id,
      status: { $in: ['new', 'reviewing', 'watchlist'] },
      score: { $gte: 40 },
    }),
    CidrIntelligence.countDocuments({
      workspace_id: ws._id,
      status: 'watchlist',
    }),
  ]);

  res.json({ newCount, criticalCount, totalActive, watchlistCount, asOf: new Date() });
});

// Main intelligence list view
//
// Range-aware. Behaviour:
//   - range=today (default): query live CidrIntelligence (60-second worker output)
//   - any other range:       query CidrDailySnapshot for the date range,
//                            aggregate per-CIDR across days, enrich with live
//                            intelligence record where available (for ASN,
//                            score, historical_match).
//
// This separation matters because the 60s worker keeps overwriting
// CidrIntelligence with the current 24h window. Past ranges must come
// from CidrDailySnapshot which is the immutable historical record.
router.get('/intelligence', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const { CidrDailySnapshot } = require('../../models');

  // ── Range handling ──────────────────────────────────────────────────
  // The rules:
  //   - If BOTH date_from and date_to are present, they win regardless of
  //     dropdown selection. The dates are explicit; dropdown is a shortcut.
  //     This treats `?range=today&date_from=X&date_to=Y` as custom-range mode.
  //   - If range is `today` with no dates, use live mode (CidrIntelligence).
  //   - Otherwise use parseRange to derive a window from the dropdown.
  const rawRange  = req.query.range || 'today';
  const dateFrom  = (req.query.date_from || '').trim();
  const dateTo    = (req.query.date_to   || '').trim();
  const hasDates  = !!(dateFrom && dateTo);
  // Effective range string used for downstream UI labelling and parse
  const rangeKey  = hasDates ? 'custom' : rawRange;

  let rangeStart = null, rangeEnd = null, rangeIsLive = false;

  if (rangeKey === 'today' && !hasDates) {
    // Truly live - no dates given, dropdown says today
    rangeIsLive = true;
  } else {
    const parsed = parseRange({
      range: rangeKey,
      date_from: dateFrom,
      date_to:   dateTo,
    });
    rangeStart = parsed.gte || null;
    rangeEnd   = parsed.lte || null;
    rangeIsLive = false;
  }

  // Status filter — default 'active' includes new/reviewing/watchlist (all
  // statuses that still need a decision). Exported/blocked/dismissed are
  // hidden by default because they've been dealt with.
  const statusFilter = req.query.status || 'active';
  let statusQuery;
  if (statusFilter === 'active')           statusQuery = { $in: ['new', 'reviewing', 'watchlist'] };
  else if (statusFilter === 'all_flagged') statusQuery = { $in: ['new', 'reviewing', 'watchlist', 'blocked', 'exported'] };
  else if (statusFilter === 'all')         statusQuery = { $in: ['new', 'reviewing', 'watchlist', 'blocked', 'exported', 'dismissed'] };
  else                                     statusQuery = statusFilter;

  // Score filter
  // Default 20 (not 40): in small windows or fresh deploys, subnets that
  // fire triggers can score 20-39 from current-window evidence alone, with
  // persistence pushing them higher over time. Hiding 20-39 makes the page
  // look empty even when triggers are firing.
  const minScore = parseInt(req.query.min_score, 10) || 20;

  // IP version filter
  const versionFilter = req.query.version || 'all';

  // Cloudflare export filter
  const cfFilter = req.query.cf || 'all';

  // Frequency filter (HIGH/MEDIUM/LOW abuser grading, separate from score).
  // Values: 'all' (default), 'high', 'medium', 'low', 'labelled' (any of the
  // three), 'unlabelled' (CIDRs that haven't qualified for a label).
  const freqFilter = req.query.frequency || 'all';

  // Pagination
  const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 50, 10), 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const skip = (page - 1) * perPage;

  // Sort parameter — declared once, used by both live and snapshot branches.
  // Previously this was scoped inside the live branch, which would throw a
  // ReferenceError if a snapshot-branch render ever reached the EJS
  // `typeof sortParam !== 'undefined'` check.
  const sortParam = req.query.sort || 'score_desc';

  // Helper to apply frequency filter to a Mongo filter object. Centralised
  // so both live and snapshot branches and the export endpoints stay in sync.
  function applyFrequencyFilter(filter, value) {
    if (value === 'high' || value === 'medium' || value === 'low') {
      filter.frequency_label = value;
    } else if (value === 'labelled') {
      filter.frequency_label = { $in: ['high', 'medium', 'low'] };
    } else if (value === 'unlabelled') {
      filter.frequency_label = null;
    }
    // 'all' → no constraint
    return filter;
  }

  let entries = [];
  let lastAnalysedAt = null;
  let totalEntries = 0;
  // The CIDR set the stat counts should be computed over. Populated by
  // the snapshot branch when in past-range mode. Null in live mode (stats
  // use direct workspace counts). Without this, stat counts could exceed
  // totalEntries because they'd be computed against an unfiltered window
  // CIDR set while the listing shows a filtered subset.
  let statsCidrSet = null;
  // The listing's filter object, hoisted out of the rangeIsLive branch
  // so the stats compute block downstream can reuse it. Without this,
  // referencing `filter` from the stats block throws ReferenceError —
  // which crashed the route on the first live render after the v2.2.3
  // patch. Declared as `let` because the live branch overwrites it
  // with the live-mode filter; remains null in snapshot mode (the stats
  // block uses statsCidrSet instead).
  let filter = null;

  // Stat-card values hoisted so the past-range branch can populate them
  // directly from its in-memory filtered set (snapshot-first means the
  // generic countDocuments approach below doesn't apply). When the past-
  // range branch sets these, it also flips skipGenericStats=true so the
  // downstream Mongo-based stats block is bypassed.
  let statCritical, statHigh, statWatching, statShown, statWatchlist;
  let statFreqHigh, statFreqMedium, statFreqLow;
  let skipGenericStats = false;

  if (rangeIsLive) {
    // ── TODAY view: read live CidrIntelligence ─────────────────────
    filter = {
      workspace_id: ws._id,
      status: statusQuery,
      score: { $gte: minScore },
    };
    if (versionFilter !== 'all') filter.ip_version = versionFilter;
    if (cfFilter === 'cf_yes') filter.cf_exported = true;
    else if (cfFilter === 'cf_no') filter.cf_exported = { $ne: true };
    applyFrequencyFilter(filter, freqFilter);

    // Frequency labels sort by a synthetic rank — high > medium > low > null.
    // We use $cond/$switch in aggregations but for find().sort() Mongo can
    // sort strings, which would give alphabetical (high/low/medium — wrong).
    // For freq sort we fall back to using addFields via aggregate. To keep
    // the live branch simple we sort by frequency_label as a string AND
    // tiebreak by score, then re-order in JS for the three labels. Faster
    // and simpler than an aggregation pipeline at this scale.
    const FREQ_RANK = { high: 3, medium: 2, low: 1, null: 0, undefined: 0, '': 0 };

    const SORT_MAP = {
      score_desc:  { score: -1, last_seen: -1 },
      score_asc:   { score: 1, last_seen: -1 },
      hits_desc:   { hit_count: -1, score: -1 },
      hits_asc:    { hit_count: 1, score: -1 },
      days_desc:   { days_seen_count: -1, score: -1 },
      days_asc:    { days_seen_count: 1, score: -1 },
      conv_desc:   { conv_rate: -1, score: -1 },
      conv_asc:    { conv_rate: 1, score: -1 },
      last_seen_desc: { last_seen: -1 },
      last_seen_asc:  { last_seen: 1 },
      // Frequency sorts use a JS post-pass below to get the correct
      // high>medium>low ordering. The Mongo sort here just narrows the
      // result set to the most-relevant rows for the page.
      freq_desc:   { score: -1 },
      freq_asc:    { score: -1 },
    };
    const sortOrder = SORT_MAP[sortParam] || SORT_MAP.score_desc;

    totalEntries = await CidrIntelligence.countDocuments(filter);

    if (sortParam === 'freq_desc' || sortParam === 'freq_asc') {
      // For freq sort we need to pull a larger candidate set (since the
      // initial Mongo sort isn't by label) and re-sort in JS. Cap at 1000
      // candidates which covers the realistic case where the user wants
      // to see HIGH-frequency CIDRs first.
      const candidates = await CidrIntelligence.find(filter)
        .sort({ score: -1, last_seen: -1 })
        .limit(1000)
        .lean();
      const dir = sortParam === 'freq_desc' ? 1 : -1;
      candidates.sort((a, b) => {
        const ra = FREQ_RANK[a.frequency_label] || 0;
        const rb = FREQ_RANK[b.frequency_label] || 0;
        if (ra !== rb) return (rb - ra) * dir;
        return (b.score || 0) - (a.score || 0);  // tie-break by score desc always
      });
      entries = candidates.slice(skip, skip + perPage);
    } else {
      entries = await CidrIntelligence.find(filter)
        .sort(sortOrder)
        .skip(skip)
        .limit(perPage)
        .lean();
    }

    // Enrich each entry with its MOST-RECENT snapshot's single-day label.
    // The window label (already on the doc as e.frequency_label) tells you
    // "how this CIDR scores across the analysis window." The single-day
    // label tells you "what it looked like in its most recent day." These
    // answer different operator questions — a CIDR can be HIGH-window but
    // LOW-today (was bad, calmed down) or LOW-window but HIGH-today (new
    // burst). UI shows both stacked in the Freq column.
    if (entries.length > 0) {
      const cidrList = entries.map(e => e.cidr);
      // Pull only the latest snapshot per CIDR via aggregation. For 50-row
      // pages this is cheap; the $sort + $group respects the {cidr,date}
      // compound index that already exists for snapshot lookups.
      const latestSnaps = await CidrDailySnapshot.aggregate([
        { $match: { workspace_id: ws._id, cidr: { $in: cidrList } } },
        { $sort: { cidr: 1, date: -1 } },
        { $group: {
            _id: '$cidr',
            single_day_label:    { $first: '$frequency_label' },
            single_day_evidence: { $first: '$frequency_evidence' },
            single_day_date:     { $first: '$date' },
        }},
      ]);
      const snapMap = new Map(latestSnaps.map(s => [s._id, s]));
      for (const e of entries) {
        const s = snapMap.get(e.cidr);
        e.single_day_frequency_label    = s?.single_day_label    || null;
        e.single_day_frequency_evidence = s?.single_day_evidence || null;
        e.single_day_frequency_date     = s?.single_day_date     || null;
      }
    }

    const lastEntry = await CidrIntelligence.findOne({ workspace_id: ws._id })
      .sort({ last_analysed_at: -1 }).select('last_analysed_at').lean();
    lastAnalysedAt = lastEntry?.last_analysed_at || null;
  } else {
    // ── PAST range: aggregate from CidrDailySnapshot ────────────────
    //
    // Snapshot-first: aggregate every CIDR with snapshots in the window,
    // then left-join live state and post-filter in memory. The previous
    // approach pre-filtered snapshots by live-state score >= min_score,
    // which silently excluded CIDRs that were abusive in the window but
    // quiet today — the 7d listing showed ~187 vs the ~1000+ CIDRs in
    // the snapshot store. Score is a current-window concept and is
    // deliberately ignored in past-range mode; status, cf, version and
    // frequency filters still apply (frequency uses the window-computed
    // label that's displayed in the table, not live state's 24h label).
    const startStr = rangeStart ? rangeStart.toISOString().slice(0, 10) : '0000-01-01';
    const endStr   = rangeEnd   ? rangeEnd.toISOString().slice(0, 10)   : '9999-12-31';

    const snapMatch = {
      workspace_id: ws._id,
      date: { $gte: startStr, $lte: endStr },
    };
    if (versionFilter !== 'all') snapMatch.ip_version = versionFilter;

    const aggregated = await CidrDailySnapshot.aggregate([
      { $match: snapMatch },
      // Sort by date asc so $last in $group grabs the latest day's
      // single-day frequency label.
      { $sort: { date: 1 } },
      { $group: {
          _id: '$cidr',
          ip_version:             { $first: '$ip_version' },
          asn_org:                { $last: '$asn_org' },
          country:                { $last: '$country' },
          hits:                   { $sum: '$hits' },
          conversions:            { $sum: '$conversions' },
          max_burst_5min:         { $max: '$max_burst_5min' },
          rapid_duplicate_count:  { $sum: '$rapid_duplicate_count' },
          single_ip_hammer_count: { $sum: '$single_ip_hammer_count' },
          fake_ua_count:          { $sum: '$fake_ua_count' },
          window_days_seen:       { $sum: 1 },
          all_triggers:           { $push: '$triggers' },
          all_sources:            { $addToSet: '$source' },
          first_date_in_window:   { $min: '$date' },
          last_date_in_window:    { $max: '$date' },
          single_day_label:       { $last: '$frequency_label' },
          single_day_evidence:    { $last: '$frequency_evidence' },
          // Sum of per-day unique ad IDs across the window. Approximate
          // — if the same ad ID spans two days the sum double-counts it,
          // but in practice click IDs are unique per ad-click event.
          sum_gclids:             { $sum: '$unique_gclids' },
          sum_wbraids:            { $sum: '$unique_wbraids' },
          sum_gbraids:            { $sum: '$unique_gbraids' },
          sum_fbclids:            { $sum: '$unique_fbclids' },
          sum_msclkids:           { $sum: '$unique_msclkids' },
      }},
    ]);

    // Left-join live state for the full aggregated set so post-filtering
    // by status / cf (live-only fields) is possible. At workspace scale
    // (~1k CIDRs in a 7d window) this is a single bounded find().
    const allCidrs = aggregated.map(a => a._id);
    const liveDocs = allCidrs.length === 0 ? [] : await CidrIntelligence.find({
      workspace_id: ws._id,
      cidr: { $in: allCidrs },
    }).lean();
    const liveMap = new Map(liveDocs.map(d => [d.cidr, d]));

    // Import label computation from the analyser so single-source-of-truth
    // is preserved (thresholds defined in one place).
    const { computeFrequencyLabel } = require('../../lib/cidrAnalyser');

    const allEntries = aggregated.map(a => {
      const live = liveMap.get(a._id) || {};
      const triggerSet = new Set();
      for (const t of a.all_triggers) for (const x of (t || [])) triggerSet.add(x);
      const sources = a.all_sources || [];

      // Window frequency label — computed across the user's chosen date
      // range, not the live 24h. This overrides whatever live.frequency_label
      // says because the live label answers a different question (last 24h)
      // than what the user is viewing here.
      const windowAdIds = (a.sum_gclids || 0) + (a.sum_wbraids || 0) +
                          (a.sum_gbraids || 0) + (a.sum_fbclids || 0) +
                          (a.sum_msclkids || 0);
      const windowFreqEv = {
        days_in_window:          a.window_days_seen,
        clicks_in_window:        a.hits,
        unique_ad_ids_in_window: windowAdIds,
        conversions_in_window:   a.conversions,
        window_hours:            null,  // window comes from date range, not hours
      };
      const windowFreqLabel = computeFrequencyLabel({
        clicks:        a.hits,
        unique_ad_ids: windowAdIds,
        conversions:   a.conversions,
        days:          a.window_days_seen,
      }, 'window');

      return {
        _id:               live._id,
        cidr:              a._id,
        ip_version:        a.ip_version,
        asn_org:           a.asn_org || live.asn_org || '',
        country:           a.country || live.country || '',
        score:             live.score || 0,
        signals:           live.signals || {},
        // Window-scoped frequency overrides live for past-range views.
        frequency_label:    windowFreqLabel,
        frequency_evidence: windowFreqEv,
        // Latest day's single-day label within the window — for showing
        // "what does this CIDR look like in its most recent day" alongside
        // the multi-day verdict.
        single_day_frequency_label:    a.single_day_label || null,
        single_day_frequency_evidence: a.single_day_evidence || null,
        single_day_frequency_date:     a.last_date_in_window,
        hit_count:         a.hits,
        unique_ip_count:   live.unique_ip_count || 0,
        conversion_count:  a.conversions,
        conv_rate:         a.hits > 0 ? a.conversions / a.hits : 0,
        fake_ua_count:     a.fake_ua_count,
        max_burst_5min:    a.max_burst_5min,
        rapid_duplicate_count: a.rapid_duplicate_count,
        single_ip_hammer_count: a.single_ip_hammer_count,
        triggers_in_window: [...triggerSet],
        days_seen_count:   a.window_days_seen,
        consecutive_days:  live.consecutive_days || 0,
        first_seen_date:   a.first_date_in_window,
        last_seen_date:    a.last_date_in_window,
        first_seen:        live.first_seen || null,
        last_seen:         live.last_seen  || null,
        top_uas:           live.top_uas || [],
        sample_ips:        live.sample_ips || [],
        // Snapshot-only CIDRs have no live record yet — surface them as
        // 'new' so the default 'active' status filter includes them.
        status:            live.status || 'new',
        cf_exported:       !!live.cf_exported,
        // Also expose window ad-id totals for CSV export
        unique_gclids:     live.unique_gclids  || a.sum_gclids   || 0,
        unique_wbraids:    live.unique_wbraids || a.sum_wbraids  || 0,
        unique_gbraids:    live.unique_gbraids || a.sum_gbraids  || 0,
        unique_fbclids:    live.unique_fbclids || a.sum_fbclids  || 0,
        unique_msclkids:   live.unique_msclkids|| a.sum_msclkids || 0,
        historical_match:  live.historical_match || {
          has_history:     true,
          total_days_seen: a.window_days_seen,
          prior_days_seen: a.window_days_seen,
          first_seen_date: a.first_date_in_window,
          last_seen_date:  a.last_date_in_window,
          is_returning:    a.window_days_seen >= 2,
          is_seeded:       sources.includes('seed'),
        },
        _from_snapshot:    true,
      };
    });

    // Post-filter by status / cf / frequency. NB: score is intentionally
    // not applied in past-range mode (see header comment).
    const ACTIVE_STATUSES      = ['new', 'reviewing', 'watchlist'];
    const ALL_FLAGGED_STATUSES = ['new', 'reviewing', 'watchlist', 'blocked', 'exported'];
    const ALL_STATUSES         = ['new', 'reviewing', 'watchlist', 'blocked', 'exported', 'dismissed'];
    const statusMatches = (s) => {
      if (statusFilter === 'active')      return ACTIVE_STATUSES.includes(s);
      if (statusFilter === 'all_flagged') return ALL_FLAGGED_STATUSES.includes(s);
      if (statusFilter === 'all')         return ALL_STATUSES.includes(s);
      return s === statusFilter;
    };
    const freqMatches = (label) => {
      if (freqFilter === 'all') return true;
      if (freqFilter === 'labelled')   return ['high', 'medium', 'low'].includes(label);
      if (freqFilter === 'unlabelled') return label == null;
      return label === freqFilter;
    };
    const cfMatches = (exported) => {
      if (cfFilter === 'cf_yes') return exported === true;
      if (cfFilter === 'cf_no')  return exported !== true;
      return true;
    };
    const filtered = allEntries.filter(e =>
      statusMatches(e.status) && freqMatches(e.frequency_label) && cfMatches(e.cf_exported)
    );

    // Sort in memory. Score sort tie-breaks on hits since many snapshot-only
    // CIDRs share score=0 and we want larger window-hits surfaced first.
    const FREQ_RANK = { high: 3, medium: 2, low: 1 };
    const COMPARATORS = {
      score_desc:     (a, b) => (b.score || 0) - (a.score || 0) || (b.hit_count || 0) - (a.hit_count || 0),
      score_asc:      (a, b) => (a.score || 0) - (b.score || 0) || (b.hit_count || 0) - (a.hit_count || 0),
      hits_desc:      (a, b) => (b.hit_count || 0) - (a.hit_count || 0) || (b.score || 0) - (a.score || 0),
      hits_asc:       (a, b) => (a.hit_count || 0) - (b.hit_count || 0) || (b.score || 0) - (a.score || 0),
      days_desc:      (a, b) => (b.days_seen_count || 0) - (a.days_seen_count || 0) || (b.hit_count || 0) - (a.hit_count || 0),
      days_asc:       (a, b) => (a.days_seen_count || 0) - (b.days_seen_count || 0) || (b.hit_count || 0) - (a.hit_count || 0),
      conv_desc:      (a, b) => (b.conv_rate || 0) - (a.conv_rate || 0) || (b.hit_count || 0) - (a.hit_count || 0),
      conv_asc:       (a, b) => (a.conv_rate || 0) - (b.conv_rate || 0) || (b.hit_count || 0) - (a.hit_count || 0),
      last_seen_desc: (a, b) => String(b.last_seen_date || '').localeCompare(String(a.last_seen_date || '')),
      last_seen_asc:  (a, b) => String(a.last_seen_date || '').localeCompare(String(b.last_seen_date || '')),
      freq_desc:      (a, b) => ((FREQ_RANK[b.frequency_label] || 0) - (FREQ_RANK[a.frequency_label] || 0)) || ((b.score || 0) - (a.score || 0)),
      freq_asc:       (a, b) => ((FREQ_RANK[a.frequency_label] || 0) - (FREQ_RANK[b.frequency_label] || 0)) || ((b.score || 0) - (a.score || 0)),
    };
    const cmp = COMPARATORS[sortParam] || COMPARATORS.score_desc;
    filtered.sort(cmp);

    totalEntries = filtered.length;
    entries = filtered.slice(skip, skip + perPage);
    lastAnalysedAt = null;

    // Compute stat cards from the post-filtered set so they match the
    // listing exactly. Score buckets use the live-state score (0 for
    // snapshot-only CIDRs); freq buckets use the window-computed label
    // that's also displayed in the row. statsBase=null disables the
    // generic stats block below for past-range mode.
    statCritical   = filtered.filter(e => (e.score || 0) >= 80).length;
    statHigh       = filtered.filter(e => (e.score || 0) >= 60).length;
    statWatching   = filtered.filter(e => (e.score || 0) >= 40).length;
    statFreqHigh   = filtered.filter(e => e.frequency_label === 'high').length;
    statFreqMedium = filtered.filter(e => e.frequency_label === 'medium').length;
    statFreqLow    = filtered.filter(e => e.frequency_label === 'low').length;
    statWatchlist  = await CidrIntelligence.countDocuments({ workspace_id: ws._id, status: 'watchlist' });
    skipGenericStats = true;
  }

  // ── Summary stat cards ─────────────────────────────────────────────
  //
  // The stat cards count rows in the SAME CIDR population the listing
  // shows below. That invariant matters: if "Watching (40+)" reported a
  // number bigger than "of N total" in the pagination row, the user would
  // (correctly) lose trust in every other number on the page.
  //
  // Population definitions:
  //   - Live mode:     CidrIntelligence matching the listing's filter chain
  //                    (status/score>=min/version/cf/freq).
  //   - Snapshot mode: same filter chain, intersected with CIDRs that have
  //                    at least one snapshot in the date window. That
  //                    intersection is the bug the previous code missed —
  //                    statsCidrSet was the live-filter result alone, so
  //                    Yesterday view and 7d view got identical stat
  //                    counts even though the listings differ.
  //
  // Score buckets (Critical/High/Watching) reuse the base filter but
  // substitute their own score floor for the listing's minScore.
  // Frequency buckets inherit the full filter chain (including minScore).
  // Watchlist is workspace-wide — it answers "X on watchlist overall"
  // regardless of which view the user is in.
  // Build the live-mode stats base filter. Past-range mode populates the
  // stat variables directly inside the snapshot branch (skipGenericStats=true)
  // because its stats need the window-computed frequency labels, which the
  // generic countDocuments approach can't see.
  let statsBase = null;

  if (rangeIsLive) {
    statsBase = { ...filter };
  }

  if (statsBase !== null && !skipGenericStats) {
    // For score buckets, strip the listing's min_score floor and apply
    // each bucket's own threshold. For frequency buckets, inherit the
    // listing's full filter (including any explicit frequency choice).
    const scoreBase = { ...statsBase };
    delete scoreBase.score;
    const freqBase = { ...statsBase };
    // The frequency filter chosen by the user shouldn't gate the per-label
    // cards — otherwise picking "HIGH only" makes MED/LOW cards show 0.
    // Always count per-label across the base population.
    delete freqBase.frequency_label;

    [statCritical, statHigh, statWatching, statWatchlist,
     statFreqHigh, statFreqMedium, statFreqLow] = await Promise.all([
      CidrIntelligence.countDocuments({ ...scoreBase, score: { $gte: 80 } }),
      CidrIntelligence.countDocuments({ ...scoreBase, score: { $gte: 60 } }),
      CidrIntelligence.countDocuments({ ...scoreBase, score: { $gte: 40 } }),
      CidrIntelligence.countDocuments({ workspace_id: ws._id, status: 'watchlist' }),
      CidrIntelligence.countDocuments({ ...freqBase, frequency_label: 'high' }),
      CidrIntelligence.countDocuments({ ...freqBase, frequency_label: 'medium' }),
      CidrIntelligence.countDocuments({ ...freqBase, frequency_label: 'low' }),
    ]);
  }
  statShown = entries.length;

  const totalPages = Math.max(1, Math.ceil(totalEntries / perPage));

  res.render('admin/intelligence', {
    ws,
    page: 'intelligence',
    entries,
    statusFilter,
    minScore,
    versionFilter,
    cfFilter,
    sortParam: typeof sortParam !== 'undefined' ? sortParam : 'score_desc',
    rangeKey,
    rangeStart,
    rangeEnd,
    rangeIsLive,
    dateFrom: dateFrom,
    dateTo: dateTo,
    stats: {
      critical: statCritical, high: statHigh, watching: statWatching,
      shown: statShown, watchlist: statWatchlist,
      freq_high: statFreqHigh, freq_medium: statFreqMedium, freq_low: statFreqLow,
    },
    freqFilter,
    lastAnalysedAt,
    // Pagination
    currentPage: page,
    perPage,
    totalEntries,
    totalPages,
  });
});

// Update status — block / export / dismiss / reviewing
router.post('/intelligence/:id/status', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const { status, notes } = req.body;
  const validStatuses = CidrIntelligence.STATUSES || ['new', 'reviewing', 'watchlist', 'blocked', 'exported', 'dismissed'];
  if (!validStatuses.includes(status)) return res.redirect('/admin/intelligence');

  const update = { status, notes: (notes || '').slice(0, 500) };
  if (status === 'blocked')   update.blocked_at      = new Date();
  if (status === 'exported')  update.exported_at     = new Date();
  if (status === 'dismissed') update.dismissed_at    = new Date();
  if (status === 'watchlist') update.watchlisted_at  = new Date();

  await CidrIntelligence.updateOne(
    { _id: req.params.id, workspace_id: ws._id },
    { $set: update }
  );
  // Express deprecated `res.redirect('back')`; use the Referer header
  // with a sensible fallback so this stays working on Express 5+.
  res.redirect(req.get('Referer') || '/admin/intelligence');
});

// Bulk status update — select multiple CIDRs and act on them.
// Accepts ids as either an array (`ids[]=…&ids[]=…`) or a comma-separated
// string for compatibility with both common form patterns.
router.post('/intelligence/bulk', async (req, res) => {
  const ws = await resolveWorkspace(req);
  let raw = req.body.ids;
  let ids = [];
  if (Array.isArray(raw)) ids = raw.flatMap(v => String(v).split(','));
  else                    ids = String(raw || '').split(',');
  ids = ids.map(s => s.trim()).filter(Boolean);

  const status = req.body.status;
  const validStatuses = ['blocked', 'exported', 'dismissed', 'reviewing', 'watchlist'];
  if (!ids.length || !validStatuses.includes(status)) return res.redirect('/admin/intelligence');

  const update = { status };
  if (status === 'blocked')   update.blocked_at      = new Date();
  if (status === 'exported')  update.exported_at     = new Date();
  if (status === 'dismissed') update.dismissed_at    = new Date();
  if (status === 'watchlist') update.watchlisted_at  = new Date();

  await CidrIntelligence.updateMany(
    { _id: { $in: ids }, workspace_id: ws._id },
    { $set: update }
  );
  res.redirect(req.get('Referer') || '/admin/intelligence');
});

// Delete a single entry
router.post('/intelligence/:id/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  await CidrIntelligence.deleteOne({ _id: req.params.id, workspace_id: ws._id });
  res.redirect('/admin/intelligence');
});

// Trigger manual analysis run
router.post('/intelligence/run-now', async (req, res) => {
  try {
    const { runAnalysis } = require('../../lib/cidrAnalyser');
    runAnalysis();  // fire and forget — runs in background
  } catch (e) { /* logged inside */ }
  res.redirect('/admin/intelligence');
});

// ---------- Run analysis over a specific time frame ----------
//
// Triggers a one-shot analysis pass over the chosen date range. This is what
// the time frame selector in the UI calls. Unlike the 60-second worker which
// always uses the configured default window, this lets you ask "analyse last
// week's data and refresh the intelligence view."
router.post('/intelligence/analyse-range', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const rawRange  = String(req.body.range || '').trim();
  const dateFrom  = String(req.body.date_from || '').trim();
  const dateTo    = String(req.body.date_to || '').trim();
  const hasDates  = !!(dateFrom && dateTo);
  // If user supplied both dates, treat as custom range regardless of dropdown.
  // The dates are explicit; dropdown is a shortcut.
  const effectiveRange = hasDates ? 'custom' : (rawRange || 'today');

  // Reuse the existing parseRange helper - matches the date selector pattern
  // used across the rest of the admin UI.
  const parsed = parseRange({
    range: effectiveRange,
    date_from: dateFrom,
    date_to: dateTo,
  });

  const opts = {};
  if (parsed.gte) opts.windowStart = parsed.gte;
  if (parsed.lte) opts.windowEnd = parsed.lte;
  // If no explicit start, fall back to "today" range (midnight UTC → now)
  if (!parsed.gte && !parsed.lte) {
    opts.windowStart = new Date();
    opts.windowStart.setHours(0, 0, 0, 0);
  }

  // Compute windowHours for storage on the resulting intelligence record
  const windowMs = (opts.windowEnd || new Date()) - (opts.windowStart || new Date());
  opts.windowHours = Math.max(1, Math.round(windowMs / (60 * 60 * 1000)));

  // For non-today ranges, write snapshots but DON'T pollute live state.
  // The 60-second worker would otherwise overwrite our results within a
  // minute, since it always uses the default 24h window.
  const isToday = effectiveRange === 'today';
  opts.writeLiveState = isToday;
  opts.writeSnapshots = true;
  // referenceDate ensures snapshot/today bucket math and live-state
  // timestamps anchor to the analysed window's END rather than wall-clock
  // now. Without this, re-analysing last Tuesday would treat Tuesday's
  // appearance as "today's return", inflating consecutive_days and
  // is_returning on the live record.
  opts.referenceDate = opts.windowEnd || new Date();

  try {
    const { analyseWorkspace } = require('../../lib/cidrAnalyser');
    // Await completion so the redirect lands on populated data, not empty.
    // At 2,600 clicks/day scale this completes in <1 second.
    await analyseWorkspace(ws._id, opts);
  } catch (e) {
    logger.warn('analyse_range_failed', { err: e.message });
  }

  // Redirect with the actually-used range so the GET handler matches.
  // (If user picked Yesterday but typed dates too, we ran custom, redirect with custom.)
  const qs = new URLSearchParams({ range: effectiveRange });
  if (dateFrom) qs.set('date_from', dateFrom);
  if (dateTo)   qs.set('date_to', dateTo);
  res.redirect('/admin/intelligence?' + qs.toString());
});

// ---------- Snapshot history (CidrDailySnapshot) ----------
//
// Browse snapshots by date or by CIDR. Shows which CIDRs have been flagged
// historically and how often.
router.get('/intelligence/history', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const { CidrDailySnapshot } = require('../../models');

  const view = req.query.view === 'cidr' ? 'cidr' : 'date';
  const date = req.query.date || null;
  const cidr = req.query.cidr || null;

  let snapshots = [];
  let cidrSummary = [];
  let dateSummary = [];

  if (view === 'date' && date) {
    snapshots = await CidrDailySnapshot.find({
      workspace_id: ws._id, date,
    }).sort({ hits: -1 }).limit(500).lean();
  } else if (view === 'cidr' && cidr) {
    snapshots = await CidrDailySnapshot.find({
      workspace_id: ws._id, cidr,
    }).sort({ date: -1 }).limit(500).lean();
  } else {
    // Default summary view
    const recurringAgg = await CidrDailySnapshot.aggregate([
      { $match: { workspace_id: ws._id } },
      { $group: {
          _id: '$cidr',
          days: { $sum: 1 },
          total_hits: { $sum: '$hits' },
          last_date: { $max: '$date' },
          first_date: { $min: '$date' },
          asn_org: { $last: '$asn_org' },
          ip_version: { $last: '$ip_version' },
          sources: { $addToSet: '$source' },
      }},
      { $sort: { days: -1 } },
      { $limit: 100 },
    ]);
    cidrSummary = recurringAgg;

    const dateAgg = await CidrDailySnapshot.aggregate([
      { $match: { workspace_id: ws._id } },
      { $group: {
          _id: '$date',
          cidr_count: { $sum: 1 },
          total_hits: { $sum: '$hits' },
      }},
      { $sort: { _id: -1 } },
      { $limit: 60 },
    ]);
    dateSummary = dateAgg;
  }

  res.render('admin/intelligence_history', {
    ws, page: 'intelligence',
    view, date, cidr,
    snapshots, cidrSummary, dateSummary,
  });
});

// ---------- Seed import ----------
//
// Accepts pasted text (plain CIDR list, wildcard list, or CSV) and creates
// CidrDailySnapshot entries marked source='seed'. Used to import:
//   - Existing Google Ads exclusion lists
//   - The comprehensive firewall CSV
//   - Any third-party blocklist
router.get('/intelligence/seed', async (req, res) => {
  const ws = await resolveWorkspace(req);
  res.render('admin/intelligence_seed', {
    ws, page: 'intelligence',
    result: null,
  });
});

router.post('/intelligence/seed', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const { parseText, importSeeds } = require('../../lib/cidrSeed');

  const text = String(req.body.text || '');
  const seedSource = String(req.body.seed_source || 'manual_import').slice(0, 100);
  const seedDate = req.body.seed_date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.seed_date)
    ? req.body.seed_date : undefined;

  const { valid, invalid } = parseText(text);
  let importResult = { imported: 0, skipped: 0 };
  if (valid.length > 0) {
    importResult = await importSeeds(ws._id, valid, { seedSource, seedDate });
  }

  res.render('admin/intelligence_seed', {
    ws, page: 'intelligence',
    result: {
      valid_count: valid.length,
      invalid_count: invalid.length,
      invalid_samples: invalid.slice(0, 10),
      imported: importResult.imported,
      skipped: importResult.skipped,
      seed_source: seedSource,
    },
  });
});

// Export flagged CIDRs as Google Ads exclusion list
// Format: IPv4 → x.x.x.* wildcard, IPv6 → compressed CIDR
// Export — plain CIDR list, one per line, no comments. Google Ads ready.
// GET does NOT change status (no side effects on download).
// Only exports entries not yet exported, unless ?include_exported=1.
// ─── Export endpoints ────────────────────────────────────────────────
//
// Two export shapes serve different workflows:
//
//   /intelligence/export.txt  — plain CIDR list, one per line. This is the
//                               format Google Ads accepts when pasting into
//                               an IP exclusion list. IPv4 emitted as /24
//                               CIDR; IPv6 as the stored /32 CIDR.
//
//   /intelligence/export-detailed.csv — full grid CSV for spreadsheet/audit
//                                       use. Includes score breakdown,
//                                       evidence, status, ASN, and timing.
//
// Both endpoints are RANGE-AWARE. They mirror the main /intelligence GET
// route's branching:
//
//   - range=today (default) OR no dates: read live CidrIntelligence (24h)
//   - any other range:                   aggregate from CidrDailySnapshot
//                                        within the window, intersected
//                                        with the live-state filters.
//
// This matches what the user sees on screen. Without this, the export
// always returned live state regardless of the date selector — which made
// "export what I'm looking at" effectively impossible for past ranges.
//
// Filters honoured by both:
//   min_score, status, version, cf, range, date_from, date_to, include_exported

function buildExportFilter(ws, query) {
  const includeExported = query.include_exported === '1';
  const statusParam = (query.status || '').trim();
  const minScore = parseInt(query.min_score, 10) || 60;
  const version = query.version || 'all';
  const cf = query.cf || 'all';
  const freq = (query.frequency || 'all').trim();

  // Default status set: actionable + already-blocked. Watchlist is included
  // when the caller explicitly asks for it via status=watchlist or status=all_flagged.
  let statusIn = includeExported
    ? ['new', 'reviewing', 'watchlist', 'blocked', 'exported']
    : ['new', 'reviewing', 'blocked'];

  if (statusParam === 'active')           statusIn = ['new', 'reviewing', 'watchlist'];
  else if (statusParam === 'watchlist')   statusIn = ['watchlist'];
  else if (statusParam === 'all_flagged') statusIn = ['new', 'reviewing', 'watchlist', 'blocked', 'exported'];
  else if (statusParam === 'all')         statusIn = ['new', 'reviewing', 'watchlist', 'blocked', 'exported', 'dismissed'];
  else if (statusParam && ['new', 'reviewing', 'blocked', 'exported', 'dismissed'].includes(statusParam)) statusIn = [statusParam];

  const filter = {
    workspace_id: ws._id,
    status: { $in: statusIn },
    score: { $gte: minScore },
  };
  if (version !== 'all') filter.ip_version = version;
  if (cf === 'cf_yes') filter.cf_exported = true;
  else if (cf === 'cf_no') filter.cf_exported = { $ne: true };
  // Frequency filter — accept 'high'/'medium'/'low'/'labelled'/'unlabelled'.
  // Exports default to NOT filtering by frequency (so a min-score-based
  // export still emits all qualifying CIDRs regardless of label).
  if (freq === 'high' || freq === 'medium' || freq === 'low') filter.frequency_label = freq;
  else if (freq === 'labelled')   filter.frequency_label = { $in: ['high', 'medium', 'low'] };
  else if (freq === 'unlabelled') filter.frequency_label = null;
  return filter;
}

// Decide whether the caller wants live (today) or past-range data.
// Mirrors the logic in the main GET route handler.
function resolveExportRange(query) {
  const rawRange = (query.range || 'today').toLowerCase();
  const dateFrom = (query.date_from || '').trim();
  const dateTo   = (query.date_to   || '').trim();
  const hasDates = !!(dateFrom && dateTo);
  const isLive   = (rawRange === 'today' && !hasDates);
  return { isLive, rawRange, dateFrom, dateTo, hasDates };
}

// Resolve the set of entries that should be exported. Returns a uniform
// array of "entry"-shaped objects matching what the EJS view receives.
// Used by both export.txt and export-detailed.csv so they stay in sync
// with the on-screen list.
async function resolveEntriesForExport(ws, query, hardLimit) {
  const liveFilter = buildExportFilter(ws, query);
  const { isLive, rawRange, dateFrom, dateTo } = resolveExportRange(query);
  const { CidrDailySnapshot } = require('../../models');

  if (isLive) {
    // Live mode: straight read from CidrIntelligence
    const entries = await CidrIntelligence.find(liveFilter)
      .sort({ score: -1 })
      .limit(hardLimit)
      .lean();
    // Enrich with latest-snapshot single-day label (same logic as the
    // /admin/intelligence GET route) so CSV exports carry both axes.
    if (entries.length > 0) {
      const cidrList = entries.map(e => e.cidr);
      const latestSnaps = await CidrDailySnapshot.aggregate([
        { $match: { workspace_id: ws._id, cidr: { $in: cidrList } } },
        { $sort: { cidr: 1, date: -1 } },
        { $group: {
            _id: '$cidr',
            single_day_label:    { $first: '$frequency_label' },
            single_day_evidence: { $first: '$frequency_evidence' },
            single_day_date:     { $first: '$date' },
        }},
      ]);
      const snapMap = new Map(latestSnaps.map(s => [s._id, s]));
      for (const e of entries) {
        const s = snapMap.get(e.cidr);
        e.single_day_frequency_label    = s?.single_day_label    || null;
        e.single_day_frequency_evidence = s?.single_day_evidence || null;
        e.single_day_frequency_date     = s?.single_day_date     || null;
      }
    }
    return entries;
  }

  // Past-range: aggregate snapshots in the window, intersect with the
  // live-state filter, return enriched entries.
  const parsed = parseRange({
    range: dateFrom && dateTo ? 'custom' : rawRange,
    date_from: dateFrom,
    date_to: dateTo,
  });

  const startStr = parsed.gte ? parsed.gte.toISOString().slice(0, 10) : '0000-01-01';
  const endStr   = parsed.lte ? parsed.lte.toISOString().slice(0, 10) : '9999-12-31';

  // Resolve which CIDRs match the live-state filter first
  const allowedDocs = await CidrIntelligence.find(liveFilter)
    .select('cidr').lean();
  if (allowedDocs.length === 0) return [];
  const allowedCidrs = allowedDocs.map(d => d.cidr);

  const snapMatch = {
    workspace_id: ws._id,
    date: { $gte: startStr, $lte: endStr },
    cidr: { $in: allowedCidrs },
  };
  const versionFilter = query.version || 'all';
  if (versionFilter !== 'all') snapMatch.ip_version = versionFilter;

  const aggregated = await CidrDailySnapshot.aggregate([
    { $match: snapMatch },
    { $sort: { date: 1 } },
    { $group: {
        _id: '$cidr',
        ip_version:             { $first: '$ip_version' },
        asn_org:                { $last: '$asn_org' },
        country:                { $last: '$country' },
        hits:                   { $sum: '$hits' },
        conversions:            { $sum: '$conversions' },
        max_burst_5min:         { $max: '$max_burst_5min' },
        rapid_duplicate_count:  { $sum: '$rapid_duplicate_count' },
        single_ip_hammer_count: { $sum: '$single_ip_hammer_count' },
        fake_ua_count:          { $sum: '$fake_ua_count' },
        window_days_seen:       { $sum: 1 },
        first_date_in_window:   { $min: '$date' },
        last_date_in_window:    { $max: '$date' },
        single_day_label:       { $last: '$frequency_label' },
        single_day_evidence:    { $last: '$frequency_evidence' },
    }},
    { $sort: { hits: -1 } },
    { $limit: hardLimit },
  ]);

  if (aggregated.length === 0) return [];

  // Re-fetch full live docs for the visible CIDRs to get full signal/status/etc
  const visibleCidrs = aggregated.map(a => a._id);
  const liveDocs = await CidrIntelligence.find({
    workspace_id: ws._id,
    cidr: { $in: visibleCidrs },
  }).lean();
  const liveMap = new Map(liveDocs.map(d => [d.cidr, d]));

  // Merge: aggregated window metrics override the live 24h hit_count/
  // conversion_count so the CSV reflects what the user saw on screen for
  // the chosen window.
  return aggregated.map(a => {
    const live = liveMap.get(a._id) || {};
    return {
      ...live,
      cidr: a._id,
      ip_version: a.ip_version,
      asn_org: a.asn_org || live.asn_org || '',
      country: a.country || live.country || '',
      // Window-scoped metrics override live's 24h numbers
      hit_count: a.hits,
      conversion_count: a.conversions,
      conv_rate: a.hits > 0 ? a.conversions / a.hits : 0,
      max_burst_5min: a.max_burst_5min,
      rapid_duplicate_count: a.rapid_duplicate_count,
      single_ip_hammer_count: a.single_ip_hammer_count,
      fake_ua_count: a.fake_ua_count,
      days_seen_count: a.window_days_seen,
      first_seen_date: a.first_date_in_window,
      last_seen_date:  a.last_date_in_window,
      // Score/signals/status come from live state — there's only one of
      // those regardless of window, and that's the authoritative value
      // the operator acts on.
      score: live.score || 0,
      signals: live.signals || {},
      status: live.status || 'new',
      cf_exported: !!live.cf_exported,
      single_day_frequency_label:    a.single_day_label || null,
      single_day_frequency_evidence: a.single_day_evidence || null,
      single_day_frequency_date:     a.last_date_in_window,
    };
  });
}

// CSV escaping — wraps the value in quotes only when needed and escapes
// embedded quotes by doubling them, per RFC 4180.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Plain CIDR list — one entry per line. Format Google Ads expects.
async function handleExportTxt(req, res) {
  const ws = await resolveWorkspace(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const entries = await resolveEntriesForExport(ws, req.query, limit);

  // Plain list — one IP block per line, nothing else.
  // For v4 we emit wildcard form (1.2.3.*) because that's what the existing
  // exclusion lists use and what Google Ads users have historically pasted;
  // for v6 we keep CIDR form since wildcard for IPv6 has no clean shorthand.
  const lines = entries.map(e => {
    if (e.ip_version === 'v4') {
      const parts = e.cidr.split('/')[0].split('.');
      return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
    }
    return e.cidr;
  });

  const today = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="botguard-cidr-${today}.txt"`);
  res.send(lines.join('\n'));
}

router.get('/intelligence/export.txt', handleExportTxt);
// Backwards-compat: the old route was `export.csv` but returned plain text.
// Keep that path serving the same plain-text content so existing bookmarks/
// scripts don't break. A NEW richer CSV is served at `export-detailed.csv`
// (see below) and surfaced as the "Download CSV" button in the UI.
router.get('/intelligence/export.csv', async (req, res) => {
  // If the caller passes `format=csv` or `detailed=1` explicitly, route to
  // the rich CSV. Otherwise preserve legacy behaviour (plain text list).
  if (req.query.format === 'csv' || req.query.detailed === '1') {
    return handleExportCsv(req, res);
  }
  return handleExportTxt(req, res);
});

// Full CSV with all evidence columns — for spreadsheet review and audit.
async function handleExportCsv(req, res) {
  const ws = await resolveWorkspace(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
  const entries = await resolveEntriesForExport(ws, req.query, limit);

  const headers = [
    'cidr', 'ip_version', 'asn_org', 'country', 'score',
    // Frequency grading — two axes
    'frequency_label',                  // window verdict (range-scoped)
    'freq_days_in_window', 'freq_clicks_in_window',
    'freq_unique_ad_ids_in_window', 'freq_window_hours',
    'single_day_frequency_label',       // most recent day's verdict
    'single_day_freq_date',
    'single_day_freq_clicks', 'single_day_freq_unique_ad_ids',
    'status', 'cf_exported',
    'hit_count', 'blocked_hits', 'unique_ip_count',
    'conversion_count', 'conv_rate',
    // signal breakdown
    'sig_volume', 'sig_conversion', 'sig_rotation', 'sig_ua_uniform',
    'sig_persistence', 'sig_fake_ua', 'sig_click_id', 'sig_temporal',
    'sig_webview_ua', 'sig_behavioral', 'sig_slow_drip', 'sig_bounce',
    'sig_known_list',
    'sig_historical_ids', 'sig_frequency',
    // click-ID counts
    'unique_gclids', 'unique_wbraids', 'unique_gbraids',
    'unique_fbclids', 'unique_msclkids', 'hits_with_no_click_id',
    // temporal / behavioral evidence
    'sub_second_burst_count', 'sub_5s_burst_count', 'min_gap_ms',
    'webview_bot_count', 'same_ip_ua_repeat_count', 'ua_diversity_ratio',
    'slow_drip_ip_count', 'hits_per_ip',
    // dwell
    'avg_dwell_ms', 'bounce_rate_5s', 'dwell_sample_count',
    // persistence
    'days_seen_count', 'consecutive_days',
    'first_seen', 'last_seen', 'last_analysed_at',
    // status timestamps
    'blocked_at', 'exported_at', 'dismissed_at', 'watchlisted_at',
    'notes',
  ];

  const rows = [headers.map(csvCell).join(',')];
  for (const e of entries) {
    const s = e.signals || {};
    const fe = e.frequency_evidence || {};
    const row = [
      e.cidr, e.ip_version, e.asn_org, e.country, e.score,
      e.frequency_label || '',
      fe.days_in_window || 0,
      fe.clicks_in_window || 0,
      fe.unique_ad_ids_in_window || 0,
      fe.window_hours || '',
      e.single_day_frequency_label || '',
      e.single_day_frequency_date  || '',
      e.single_day_frequency_evidence?.clicks || 0,
      e.single_day_frequency_evidence?.unique_ad_ids || 0,
      e.status, e.cf_exported ? '1' : '0',
      e.hit_count, e.blocked_hits, e.unique_ip_count,
      e.conversion_count, (e.conv_rate || 0).toFixed(4),
      s.volume || 0, s.conversion || 0, s.rotation || 0, s.ua_uniform || 0,
      s.persistence || 0, s.fake_ua || 0, s.click_id || 0, s.temporal || 0,
      s.webview_ua || 0, s.behavioral || 0, s.slow_drip || 0, s.bounce || 0,
      s.known_list || 0,
      s.historical_ids || 0, s.frequency || 0,
      e.unique_gclids, e.unique_wbraids, e.unique_gbraids,
      e.unique_fbclids, e.unique_msclkids, e.hits_with_no_click_id,
      e.sub_second_burst_count, e.sub_5s_burst_count, e.min_gap_ms,
      e.webview_bot_count, e.same_ip_ua_repeat_count, e.ua_diversity_ratio,
      e.slow_drip_ip_count, e.hits_per_ip,
      e.avg_dwell_ms == null ? '' : e.avg_dwell_ms,
      e.bounce_rate_5s == null ? '' : e.bounce_rate_5s,
      e.dwell_sample_count,
      e.days_seen_count, e.consecutive_days,
      e.first_seen ? new Date(e.first_seen).toISOString() : '',
      e.last_seen ? new Date(e.last_seen).toISOString() : '',
      e.last_analysed_at ? new Date(e.last_analysed_at).toISOString() : '',
      e.blocked_at    ? new Date(e.blocked_at).toISOString()    : '',
      e.exported_at   ? new Date(e.exported_at).toISOString()   : '',
      e.dismissed_at  ? new Date(e.dismissed_at).toISOString()  : '',
      e.watchlisted_at? new Date(e.watchlisted_at).toISOString(): '',
      e.notes || '',
    ];
    rows.push(row.map(csvCell).join(','));
  }

  const today = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="botguard-cidr-${today}.csv"`);
  // BOM helps Excel detect UTF-8 correctly on Windows.
  res.send('\uFEFF' + rows.join('\n'));
}

// Dedicated path so the UI can link to the rich CSV without relying on
// query-param routing. Both paths produce the same output.
router.get('/intelligence/export-detailed.csv', handleExportCsv);

// Mark exported — call AFTER pasting into Google Ads. Moves all
// qualifying entries to 'exported' status so they disappear from
// the active view.
//
// NOTE: watchlist entries are deliberately excluded from this bulk action.
// The user put them on watchlist precisely to monitor without exporting,
// so flipping them to exported here would silently override that intent.
// If a user wants a watchlisted CIDR exported, they should change its
// status individually first.
router.post('/intelligence/mark-exported', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const minScore = parseInt(req.body.min_score, 10) || 60;

  const result = await CidrIntelligence.updateMany(
    {
      workspace_id: ws._id,
      status: { $in: ['new', 'reviewing', 'blocked'] },
      score: { $gte: minScore },
    },
    { $set: { status: 'exported', exported_at: new Date() } }
  );
  res.redirect('/admin/intelligence');
});

// ── Intelligence settings (auto-export to Cloudflare) ────────────────

router.get('/intelligence/settings', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const autoCf = ws.settings?.intelligence_auto_cf || {
    enabled: false, min_score: 60, min_days: 2, min_hits: 5, auto_sync: true,
  };

  // Count how many CIDRs would qualify under current settings
  const qualifyingCount = await CidrIntelligence.countDocuments({
    workspace_id: ws._id,
    score: { $gte: autoCf.min_score },
    days_seen_count: { $gte: autoCf.min_days },
    hit_count: { $gte: autoCf.min_hits },
    cf_exported: { $ne: true },
    status: { $in: ['new', 'reviewing', 'blocked', 'exported'] },
  });

  const cfRuleCount = await CloudflareRule.countDocuments({
    workspace_id: ws._id, active: true,
  });

  res.render('admin/intelligence_settings', {
    ws, page: 'intelligence', autoCf, qualifyingCount, cfRuleCount,
    flash: req.query.flash || '',
  });
});

router.post('/intelligence/settings', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body;

  await ws.constructor.updateOne(
    { _id: ws._id },
    { $set: {
      'settings.intelligence_auto_cf.enabled':   body.enabled === 'on',
      'settings.intelligence_auto_cf.min_score':  parseInt(body.min_score, 10) || 60,
      'settings.intelligence_auto_cf.min_days':   parseInt(body.min_days, 10) || 2,
      'settings.intelligence_auto_cf.min_hits':   parseInt(body.min_hits, 10) || 5,
      'settings.intelligence_auto_cf.auto_sync':  body.auto_sync === 'on',
    }}
  );
  res.redirect('/admin/intelligence/settings?flash=Settings+saved');
});

// Run auto-export now (manual trigger)
router.post('/intelligence/settings/run-auto-export', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const autoCf = ws.settings?.intelligence_auto_cf || {};
  if (!autoCf.enabled) {
    return res.redirect('/admin/intelligence/settings?flash=Auto-export+is+disabled');
  }

  try {
    const count = await runAutoExport(ws);
    res.redirect(`/admin/intelligence/settings?flash=Auto-exported+${count}+CIDRs+to+Cloudflare`);
  } catch (err) {
    res.redirect(`/admin/intelligence/settings?flash=Error:+${encodeURIComponent(err.message)}`);
  }
});

/**
 * Auto-export qualifying CIDRs to Cloudflare.
 * Called from settings page (manual) or from the cidrAnalyser interval.
 */
async function runAutoExport(ws) {
  const autoCf = ws.settings?.intelligence_auto_cf || {};
  if (!autoCf.enabled) return 0;

  const qualifying = await CidrIntelligence.find({
    workspace_id: ws._id,
    score: { $gte: autoCf.min_score || 60 },
    days_seen_count: { $gte: autoCf.min_days || 2 },
    hit_count: { $gte: autoCf.min_hits || 5 },
    cf_exported: { $ne: true },
    status: { $in: ['new', 'reviewing', 'blocked', 'exported'] },
  }).lean();

  let added = 0;
  for (const entry of qualifying) {
    // Check if rule already exists in Cloudflare
    const exists = await CloudflareRule.findOne({
      workspace_id: ws._id, rule_type: 'cidr', value: entry.cidr,
    });
    if (exists) {
      // Just mark as cf_exported
      await CidrIntelligence.updateOne(
        { _id: entry._id },
        { $set: { cf_exported: true, cf_exported_at: new Date() } }
      );
      continue;
    }

    try {
      await CloudflareRule.create({
        workspace_id: ws._id, rule_type: 'cidr', value: entry.cidr,
        action: 'block', label: entry.asn_org || '',
        notes: `Auto-exported: score ${entry.score}, ${entry.hit_count} hits, ${entry.days_seen_count} days`,
        source: 'intelligence', source_ref: entry._id.toString(), active: true,
      });
      await CidrIntelligence.updateOne(
        { _id: entry._id },
        { $set: { cf_exported: true, cf_exported_at: new Date() } }
      );
      added++;
    } catch (err) {
      // Duplicate or other error — skip
    }
  }

  // Auto-sync to Cloudflare KV if enabled
  if (added > 0 && autoCf.auto_sync) {
    try {
      const { syncToCloudflareKV } = require('../../lib/cloudflareSync');
      await syncToCloudflareKV(ws._id);
    } catch (e) { /* non-fatal */ }
  }

  // Update last run stats
  await ws.constructor.updateOne(
    { _id: ws._id },
    { $set: {
      'settings.intelligence_auto_cf.last_run_at': new Date(),
      'settings.intelligence_auto_cf.last_exported_count': added,
    }}
  );

  return added;
}

// Export for use by cidrAnalyser interval
router._runAutoExport = runAutoExport;

// ---------- Settings (API keys, password info) ----------
router.get('/settings', async (req, res) => {
  const ws = await resolveWorkspace(req);
  res.render('admin/settings', { ws, page: 'settings', adminUser: req.adminUser, generated: req.query.key || null });
});

router.post('/settings/tracking', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const { isValidClarityId } = require('../../lib/tracking');
  const body = req.body || {};

  const raw = String(body.clarity_project_id || '').trim();
  // Empty string = remove. Otherwise validate format strictly.
  let clarityId = '';
  if (raw && raw.length > 0) {
    if (!isValidClarityId(raw)) {
      return res.status(400).send('Invalid Clarity project ID. Must be alphanumeric (with optional hyphens), 1-32 chars.');
    }
    clarityId = raw;
  }

  await Workspace.updateOne(
    { _id: ws._id },
    { $set: { 'settings.tracking.clarity_project_id': clarityId } }
  );

  // Invalidate the workspace cache so the new ID is picked up immediately
  // (otherwise pages would show stale config for up to 60s due to /go cache)
  await cache.invalidateWorkspace(ws.slug);

  res.redirect('/admin/settings#tracking');
});

/**
 * Set the admin UI theme. Persisted on the workspace document so it follows
 * the workspace across browsers/devices (admins typically have one workspace
 * per organization, so this is effectively a per-organization preference).
 *
 * Defaults to 'dark'. Anything other than 'light' is treated as 'dark' to
 * keep the input space tight - we don't want to hand-write CSS for
 * arbitrary theme strings.
 */
router.post('/settings/theme', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const requested = String(req.body?.theme || '').toLowerCase();
  const theme = requested === 'light' ? 'light' : 'dark';

  await Workspace.updateOne(
    { _id: ws._id },
    { $set: { 'settings.theme': theme } }
  );
  // Invalidate cache so the next /admin GET sees the new theme value
  await cache.invalidateWorkspace(ws.slug);

  res.redirect('/admin/settings#appearance');
});

/**
 * Toggle whether robots.txt blocks AI training crawlers (GPTBot, ClaudeBot,
 * Google-Extended, etc). The setting is opt-in signaling - only well-behaved
 * crawlers respect robots.txt. This does NOT replace the proxy/ASN gates,
 * which actually filter unwanted traffic at the network layer.
 *
 * After toggling we clear the in-memory robots cache so the next /robots.txt
 * request reflects the new setting immediately.
 */
router.post('/settings/crawlers', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const blockAi = req.body?.block_ai_crawlers === 'on' || req.body?.block_ai_crawlers === 'true';

  await Workspace.updateOne(
    { _id: ws._id },
    { $set: { 'settings.block_ai_crawlers': blockAi } }
  );
  await cache.invalidateWorkspace(ws.slug);

  // Clear robots.txt in-memory cache so the change takes effect immediately
  // rather than waiting for the 5-minute TTL.
  invalidateRobotsCache();

  res.redirect('/admin/settings#crawlers');
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
  // New/edited public pages should appear in /sitemap.xml on the next request.
  // /robots.txt isn't affected by SitePage changes (only by campaign root_paths).
  invalidateSitemapCache();
  res.redirect('/admin/site');
});

router.post('/site/:slug/delete', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const slug = String(req.params.slug || '').toLowerCase();
  await SitePage.deleteOne({ workspace_id: ws._id, slug });
  invalidateSitemapCache();
  res.redirect('/admin/site');
});

/**
 * Visitor-rendered preview of a saved SitePage.
 * Same semantics as /admin/pages/:id/preview - renders the page exactly as
 * a real visitor would see it (homepage, /privacy, /terms, /p/<slug>) but
 * with tracking disabled and no side effects. Useful for verifying layout,
 * the WP fingerprint injection, and noindex meta-tags.
 */
router.get('/site/:slug/preview', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const slug = String(req.params.slug || '').toLowerCase();
  const page = await SitePage.findOne({ workspace_id: ws._id, slug }).lean();
  if (!page) return res.status(404).send('Site page not found');

  setPreviewHeaders(res);
  res.send(renderPreview(page));
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
  res.render('admin/replay', {
    ws, campaigns, profiles: Object.keys(PROFILES),
    result: null, query: {}, page: 'replay',
  });
});

router.post('/replay', async (req, res) => {
  const ws = await resolveWorkspace(req);
  const body = req.body || {};
  const campaigns = await Campaign.find({ workspace_id: ws._id }).select('name slug').lean();

  // Replay is always scoped to "today" - it's a what-if-this-rule-had-been-active
  // tool for tuning your rules against current traffic, not a historical
  // analysis tool. Time selection on the form was confusing, so we removed it.
  const filter = {};
  if (body.campaign) filter.campaign_id = body.campaign;
  const sinceToday = new Date(); sinceToday.setHours(0, 0, 0, 0);
  filter.ts = { $gte: sinceToday };

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
