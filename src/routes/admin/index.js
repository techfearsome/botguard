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

  const clicks = await Click.find(filter)
    .sort({ ts: -1 })
    .limit(200)
    .populate('campaign_id', 'name slug')
    .lean();

  const campaigns = await Campaign.find({ workspace_id: ws._id }).select('name slug').lean();

  res.render('admin/clicks', {
    ws, clicks, campaigns,
    query: req.query,
    range,
    rangeOptions: RANGE_OPTIONS,
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
