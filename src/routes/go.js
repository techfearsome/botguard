const express = require('express');
const router = express.Router();

const { Workspace, Campaign, LandingPage, Click } = require('../models');
const { buildClickDoc, writeClick } = require('../lib/click');
const { pickVariant } = require('../lib/variant');
const { runFilterChain } = require('../lib/filterChain');
const { resolvePageForDevice } = require('../lib/pageResolver');
const cache = require('../lib/cache');
const { utmGateCheck } = require('../filters/utmGate');
const { countryGateCheck } = require('../filters/countryGate');
const { proxyGateCheck } = require('../filters/proxyGate');
const { hashFingerprint, behaviorFilter } = require('../filters/behavior');
const { buildInjection } = require('../lib/autoConversion');
const { buildTrackingInjection } = require('../lib/tracking');
const { buildHeartbeatInjection } = require('../lib/heartbeat');
const { live } = require('../lib/livePresence');
const { decide } = require('../scoring/decide');
const { DEFAULT_SLUG } = require('../lib/bootstrap');
const { setPingbackHeader, injectWpMeta } = require('../lib/wpFingerprint');
const logger = require('../lib/logger');

const CLICK_COOKIE = 'bg_cid';
const CLICK_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// Inject the JS challenge tag right before </body>, falling back to appending
function injectChallenge(html) {
  const tag = '<script src="/static/js/challenge.js" async></script>';
  if (!html) return html;
  if (html.includes('</body>')) {
    return html.replace('</body>', tag + '</body>');
  }
  return html + tag;
}

/**
 * Main entrypoint for /go/<slug> and custom root-path requests.
 *
 * @param {object} opts
 * @param {string} opts.workspaceSlug - workspace identifier (single-tenant uses DEFAULT_SLUG)
 * @param {string} opts.lookupKind - "slug" (default for /go/<slug>) or "root_path" (custom routes)
 * @param {string} opts.lookupValue - the slug or root_path value to resolve
 */
async function handleClick(req, res, opts) {
  const { workspaceSlug, lookupKind, lookupValue } = opts;
  try {
    const workspace = await cache.getWorkspaceBySlug(workspaceSlug, () =>
      Workspace.findOne({ slug: workspaceSlug }).lean()
    );
    if (!workspace) return res.status(404).send('Campaign not found');

    let campaign;
    if (lookupKind === 'root_path') {
      // Look up by custom root_path. We don't cache by root_path yet because
      // it's a less common lookup and the campaign object itself is small;
      // a Mongo query per visit is fine.
      campaign = await Campaign.findOne({
        workspace_id: workspace._id,
        root_path: lookupValue,
        status: { $ne: 'archived' },
      }).lean();
    } else {
      // Default: lookup by slug, with cache.
      campaign = await cache.getCampaignBySlug(workspace._id, lookupValue, () =>
        Campaign.findOne({
          workspace_id: workspace._id,
          slug: lookupValue,
          status: { $ne: 'archived' },
        }).lean()
      );
    }
    if (!campaign) return res.status(404).send('Campaign not found');

    // Build base click record
    const doc = buildClickDoc({ req, workspace, campaign });
    const deviceClass = doc.ua_parsed?.device_class || 'other';

    // --- Campaign status gate (runs FIRST, before UTM gate / ProxyCheck) ---
    // A paused campaign is "ready but disabled" - all traffic skips the filter
    // chain and goes to the safe page. This means:
    //   - No ProxyCheck call (saves the external HTTP cost)
    //   - No UTM/country/proxy gates run
    //   - No filter chain runs
    //   - No auto-conversion injection on the safe page (we never inject on safe)
    //   - The click is still logged with decision='block', reason='campaign_paused'
    //     so admins can see paused-campaign traffic in /admin/clicks and /admin/live
    //
    // Note: 'archived' campaigns are filtered out at lookup time (return 404).
    // Only 'paused' falls through to here.
    if (campaign.status === 'paused') {
      doc.scores = {
        network: 0, headers: 0, behavior: 0, pattern: 0, referer: 0,
        total: 0,
        profile_used: campaign.source_profile,
        flags: ['campaign_paused'],
      };
      doc.decision = 'block';
      doc.decision_reason = 'campaign_paused';
      doc.mode_at_decision = 'enforce';     // pause is always enforcing - not a scored decision
      doc.page_rendered = 'safe';

      const safePage = await resolvePageForDevice(campaign, deviceClass, 'safe');
      const html = safePage ? (safePage.html_template || pickVariantHtml(safePage)) : renderSafeFallback();
      if (safePage) doc.landing_page_id = safePage._id;

      writeClick(doc).catch((err) => logger.error('click_write_failed', { err: err.message }));
      registerLiveVisitor(doc, campaign, workspace);
      setGoCookies(req, res, doc);
      setNoCacheHeaders(req, res, campaign);
      return res.status(200).type('html').send(applyPageTracking(html, workspace));
    }

    // --- UTM gate (runs BEFORE the filter chain so we don't waste a ProxyCheck call) ---
    const gateResult = utmGateCheck({ utm: doc.utm, campaign });
    if (gateResult.blocked) {
      // Gate failed. Skip the filter chain entirely - this visit is already going to the safe page.
      doc.scores = {
        network: 0, headers: 0, behavior: 0, pattern: 0, referer: 0,
        total: 0,
        profile_used: campaign.source_profile,
        flags: gateResult.flags,
      };
      doc.decision = 'block';
      doc.decision_reason = `utm_gate:missing_${gateResult.missing_keys.join('_')}`;
      doc.mode_at_decision = 'enforce';   // gate is always enforcing - it's not a score
      doc.page_rendered = 'safe';

      const safePage = await resolvePageForDevice(campaign, deviceClass, 'safe');
      const html = safePage ? (safePage.html_template || pickVariantHtml(safePage)) : renderSafeFallback();

      writeClick(doc).catch((err) => logger.error('click_write_failed', { err: err.message }));
      registerLiveVisitor(doc, campaign, workspace); setGoCookies(req, res, doc); setNoCacheHeaders(req, res, campaign); return res.status(200).type('html').send(applyPageTracking(html, workspace));
    }

    // Run the filter chain
    const result = await runFilterChain({
      ip: doc.ip,
      ipHash: doc.ip_hash,
      userAgent: doc.user_agent,
      headers: req.headers,
      utm: doc.utm,
      externalIds: doc.external_ids,
      refererHost: doc.referer_host,
      inAppBrowser: doc.in_app_browser,
      fingerprint: null,            // first request - JS hasn't run yet
      workspaceId: workspace._id,
      campaign,
    });

    // Merge filter results into click doc
    Object.assign(doc, {
      asn: result.enrichment.asn,
      asn_org: result.enrichment.asn_org,
      organisation: result.enrichment.organisation,
      operator: result.enrichment.operator,
      operator_name: result.enrichment.operator_name,
      operator_anonymity: result.enrichment.operator_anonymity,
      country: result.enrichment.country,
      country_name: result.enrichment.country_name,
      region: result.enrichment.region,
      city: result.enrichment.city,
      ip_type: result.enrichment.ip_type,
      is_proxy: result.enrichment.is_proxy,
      proxy_type: result.enrichment.proxy_type,
      hosting: result.enrichment.hosting,
      scraper: result.enrichment.scraper,
      risk_score: result.enrichment.risk_score,
      scores: result.scores,
      decision: result.decision,
      decision_reason: result.decision_reason,
      mode_at_decision: result.mode_at_decision,
    });

    // --- Country gate (post-network, has ProxyCheck country verdict) ---
    const countryResult = countryGateCheck({ country: doc.country, campaign });
    if (countryResult.blocked) {
      doc.scores.flags = [...(doc.scores.flags || []), ...countryResult.flags];
      doc.decision = 'block';
      doc.decision_reason = countryResult.country
        ? `country_gate:${countryResult.mode}_block_${countryResult.country}`
        : `country_gate:${countryResult.mode}_unknown`;
      doc.mode_at_decision = 'enforce';   // gate is always enforcing
      doc.page_rendered = 'safe';

      const safePage = await resolvePageForDevice(campaign, deviceClass, 'safe');
      const html = safePage ? pickVariantHtml(safePage) : renderSafeFallback();
      writeClick(doc).catch((err) => logger.error('click_write_failed', { err: err.message }));
      registerLiveVisitor(doc, campaign, workspace); setGoCookies(req, res, doc); setNoCacheHeaders(req, res, campaign); return res.status(200).type('html').send(applyPageTracking(html, workspace));
    }
    // Append the pass flag for visibility
    doc.scores.flags = [...(doc.scores.flags || []), ...countryResult.flags];

    // --- Proxy gate (post-network, has ProxyCheck verdict + ASN/term blacklist match) ---
    const proxyResult = proxyGateCheck({
      enrichment: result.enrichment,
      networkFlags: doc.scores.flags || [],
      campaign,
    });
    if (proxyResult.blocked) {
      doc.scores.flags = [...(doc.scores.flags || []), ...proxyResult.flags];
      doc.decision = 'block';
      doc.decision_reason = `proxy_gate:${proxyResult.reason}`;
      doc.mode_at_decision = 'enforce';
      doc.page_rendered = 'safe';

      const safePage = await resolvePageForDevice(campaign, deviceClass, 'safe');
      const html = safePage ? pickVariantHtml(safePage) : renderSafeFallback();
      writeClick(doc).catch((err) => logger.error('click_write_failed', { err: err.message }));
      registerLiveVisitor(doc, campaign, workspace); setGoCookies(req, res, doc); setNoCacheHeaders(req, res, campaign); return res.status(200).type('html').send(applyPageTracking(html, workspace));
    }
    doc.scores.flags = [...(doc.scores.flags || []), ...proxyResult.flags];

    // Resolve which page to show (per-device override applies)
    const showSafePage = (doc.decision === 'block');
    const targetPage = await resolvePageForDevice(campaign, deviceClass, showSafePage ? 'safe' : 'offer');

    // ── Bot Guard (Level 2) ─────────────────────────────────────────
    // If we're about to serve an OFFER page that has bot_guard enabled,
    // and the visitor hasn't already passed the guard (no valid pass
    // cookie), serve the guard interstitial instead of the offer page.
    // The interstitial runs client-side checks and POSTs to /go/guard-verify.
    if (!showSafePage && targetPage && targetPage.kind === 'offer' &&
        targetPage.bot_guard?.enabled) {
      const { verifyPassCookie } = require('../lib/guardToken');
      const passCookie = req.cookies?.[`bg_guard_${targetPage._id}`];
      const alreadyPassed = passCookie && verifyPassCookie(passCookie, doc.ip);

      if (!alreadyPassed) {
        // Serve the guard interstitial
        const { signToken } = require('../lib/guardToken');
        const { buildGuardPage } = require('../lib/guardPage');

        // Persist the click now so guard-verify can look it up.
        // doc is a plain object (from buildClickDoc), written via writeClick.
        doc.page_rendered = 'guard';
        doc.landing_page_id = targetPage._id;
        writeClick(doc).catch((err) => logger.error('click_write_failed', { err: err.message }));

        const token = signToken({
          click_id: doc.click_id,
          offer_page_id: String(targetPage._id),
          ip: doc.ip,
        });

        const guardHtml = buildGuardPage({
          token,
          verifyUrl: '/go/guard-verify',
          config: targetPage.bot_guard,
          minDwellMs: targetPage.bot_guard.min_dwell_ms || 2000,
        });

        setGoCookies(req, res, doc);
        res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
        res.set('X-Robots-Tag', 'noindex, nofollow');
        return res.status(200).send(guardHtml);
      }
      // else: passed guard already — fall through to serve offer normally
    }

    let html, variantName;
    if (targetPage) {
      const variant = pickVariant(targetPage);
      html = variant ? variant.html : targetPage.html_template;
      variantName = variant?.name || 'default';
      doc.page_rendered = showSafePage ? 'safe' : 'offer';
      doc.landing_page_id = targetPage._id;
    } else if (showSafePage) {
      html = renderSafeFallback();
      doc.page_rendered = 'safe';
      doc.variant_shown = 'safe_fallback';
    } else {
      html = renderStubPage({ campaign, click_id: doc.click_id });
      doc.page_rendered = 'offer';
      doc.variant_shown = 'stub';
    }
    if (variantName) doc.variant_shown = variantName;

    // Template substitution
    if (html) {
      html = html
        .replace(/\{\{click_id\}\}/g, doc.click_id)
        .replace(/\{\{utm_source\}\}/g, doc.utm.source || '')
        .replace(/\{\{utm_medium\}\}/g, doc.utm.medium || '')
        .replace(/\{\{utm_campaign\}\}/g, doc.utm.campaign || '');
    }

    // Inject challenge - only on offer pages, never on safe pages
    if (doc.page_rendered === 'offer') {
      html = injectChallenge(html);

      // Auto-conversion tracking - only when explicitly enabled on the page that's actually rendering.
      // Safe pages never get this injection (we don't want auto-conversions on blocked traffic).
      if (targetPage?.auto_conversion?.enabled) {
        const injection = buildInjection({
          terms: targetPage.auto_conversion.terms,
          eventName: targetPage.auto_conversion.event_name || 'auto_click',
        });
        html = injectBeforeBodyEnd(html, injection);
        doc.auto_conv_injected = true;
      }
    }

    setGoCookies(req, res, doc);

    // CRITICAL: never cache /go responses at any layer.
    // - Each visit must get a fresh click_id cookie
    // - Cloudflare will cache HTML by default if cookies aren't on the request
    // - 'private' tells the browser only it can cache; 's-maxage=0' tells CDNs not to
    setNoCacheHeaders(req, res, campaign);

    // Persist click (non-blocking)
    writeClick(doc).catch((err) => {
      logger.error('click_write_failed', { err: err.message, click_id: doc.click_id });
    });

    registerLiveVisitor(doc, campaign, workspace);
    res.status(200).type('html').send(applyPageTracking(html, workspace));
  } catch (err) {
    logger.error('go_route_error', { err: err.message, stack: err.stack });
    res.status(500).send('Internal error');
  }
}

/**
 * POST /go/fp
 * Receives the fingerprint payload from the JS challenge, updates the click record,
 * and re-runs the behavior filter so the score reflects post-load signals.
 */
async function handleFingerprint(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const body = req.body || {};
    const cid = body.cid;
    const fp = body.fp || {};
    if (!cid) return res.status(400).json({ ok: false, error: 'missing_cid' });

    const click = await Click.findOne({ click_id: cid });
    if (!click) return res.status(404).json({ ok: false, error: 'click_not_found' });

    fp.hash = hashFingerprint(fp);

    const isPrefetcher = (click.scores?.flags || []).some((f) => f.startsWith('prefetcher_'));
    const behavior = behaviorFilter({ fingerprint: fp, isPrefetcher });

    // Recompute total with the new behavior score, keeping network/headers/pattern/referer scores as-is.
    // Strip any old behavior-layer flags out of the click's flag list before re-deciding.
    const oldFlags = (click.scores?.flags || []).filter(
      (f) => !['fp_pending','canvas_empty','canvas_uniform','webgl_missing','webgl_headless','screen_zero','screen_tiny','screen_missing','tz_missing','lang_missing','no_interaction','has_interaction','webdriver_flag','fp_skipped_prefetcher'].includes(f)
    );

    const layerScores = {
      network: click.scores?.network || 0,
      headers: click.scores?.headers || 0,
      behavior: behavior.score,
      pattern:  click.scores?.pattern || 0,
      referer:  click.scores?.referer || 0,
    };
    const layerFlags = {
      network: oldFlags,        // keep all the non-behavior flags lumped here for the decide() flatten
      headers: [],
      behavior: behavior.flags,
      pattern: [],
      referer: [],
    };

    const campaign = await Campaign.findById(click.campaign_id);
    const verdict = decide({
      layerScores,
      layerFlags,
      profile: campaign?.source_profile || 'mixed',
      campaign,
      prefetcher: isPrefetcher ? { is_prefetcher: true, kind: 'inferred' } : null,
    });

    click.fingerprint = fp;
    click.scores.behavior = behavior.score;
    click.scores.total = verdict.total;
    click.scores.flags = verdict.flags;
    click.decision = verdict.decision;
    click.decision_reason = verdict.decision_reason;
    await click.save();

    res.json({ ok: true });
  } catch (err) {
    logger.error('fp_handler_error', { err: err.message });
    res.status(500).json({ ok: false });
  }
}

// ── Bot Guard Level 2 verification endpoint ──────────────────────────
// The guard interstitial page POSTs its collected signals here. We verify
// the token, run the checks, record the result, and tell the client where
// to go: the real offer page (pass) or the safe page (fail).
async function handleGuardVerify(req, res) {
  try {
    const { verifyToken, signPassCookie } = require('../lib/guardToken');
    const { verifyGuard } = require('../lib/guardVerify');

    const signals = req.body || {};
    const payload = verifyToken(signals.token);
    if (!payload) {
      return res.status(400).json({ redirect: null, error: 'invalid_token' });
    }

    const { Click, LandingPage, Campaign } = require('../models');

    const click = await Click.findOne({ click_id: payload.click_id });
    if (!click) {
      return res.status(404).json({ redirect: null, error: 'click_not_found' });
    }

    const offerPage = await LandingPage.findById(payload.offer_page_id).lean();
    if (!offerPage) {
      return res.status(404).json({ redirect: null, error: 'page_not_found' });
    }

    // Run verification
    const verdict = verifyGuard({
      signals,
      click: click.toObject ? click.toObject() : click,
      config: offerPage.bot_guard || {},
    });

    // Record result on the click
    click.guard_result = verdict.pass ? 'pass' : 'fail';
    click.guard_flags = verdict.flags;
    click.guard_detail = verdict.detail;
    click.guard_checked_at = new Date();

    if (verdict.pass) {
      click.page_rendered = 'offer';
      await click.save().catch(() => {});

      // Set a pass cookie so a normal re-request would also serve the offer,
      // but we return the offer URL directly for immediate redirect.
      const passCookie = signPassCookie(click.click_id, click.ip);
      res.cookie(`bg_guard_${offerPage._id}`, passCookie, {
        maxAge: 30 * 60 * 1000, httpOnly: false, sameSite: 'lax', secure: true,
      });

      // Return the offer page's public URL. The offer page is served at /p/:slug
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const offerUrl = offerPage.slug
        ? `${baseUrl}/p/${offerPage.slug}?cid=${encodeURIComponent(click.click_id)}`
        : `${baseUrl}/`;
      return res.json({ redirect: offerUrl });
    } else {
      // Failed — mark as safe, feed flags into intelligence
      click.page_rendered = 'safe';
      click.scores = click.scores || {};
      click.scores.flags = [...(click.scores.flags || []), ...verdict.flags.map(f => `guard_${f}`)];
      await click.save().catch(() => {});

      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      let safeUrl = `${baseUrl}/`;
      try {
        const safePage = await LandingPage.findOne({
          workspace_id: click.workspace_id, kind: 'safe',
        }).lean();
        if (safePage && safePage.slug) safeUrl = `${baseUrl}/p/${safePage.slug}`;
      } catch (e) {}
      return res.json({ redirect: safeUrl });
    }
  } catch (err) {
    return res.status(500).json({ redirect: null, error: 'server_error' });
  }
}

router.post('/guard-verify', express.json({ limit: '16kb' }), handleGuardVerify);

router.post('/fp', express.json({ limit: '32kb' }), handleFingerprint);

// Single-tenant
router.get('/:slug', (req, res) => handleClick(req, res, {
  workspaceSlug: DEFAULT_SLUG,
  lookupKind: 'slug',
  lookupValue: req.params.slug,
}));
// Multi-tenant
router.get('/:workspaceSlug/:campaignSlug', (req, res) => handleClick(req, res, {
  workspaceSlug: req.params.workspaceSlug,
  lookupKind: 'slug',
  lookupValue: req.params.campaignSlug,
}));

function renderStubPage({ campaign, click_id }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(campaign.name)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1a1a1a}.card{background:#f7f7f7;border:1px solid #e0e0e0;border-radius:8px;padding:24px;margin:16px 0}code{background:#eaeaea;padding:2px 6px;border-radius:3px;font-size:.9em}.muted{color:#666;font-size:.9em}</style>
</head><body>
<h1>${escapeHtml(campaign.name)}</h1>
<p class="muted">No landing page configured for this campaign yet.</p>
<div class="card"><strong>Click recorded</strong><p>Click ID: <code>${click_id}</code></p></div>
<div class="card"><strong>Test conversion</strong><p><code>GET /px/conv?cid=${click_id}&value=10</code></p></div>
</body></html>`;
}

function pickVariantHtml(landingPage) {
  if (!landingPage) return '';
  const variant = pickVariant(landingPage);
  return variant ? variant.html : (landingPage.html_template || '');
}

/**
 * Inject HTML right before the closing </body> tag, or append to the document
 * if no </body> is present. Case-insensitive on the tag.
 *
 * Used for auto-conversion script and challenge - we want them to load AFTER
 * the page's own content so they don't block render.
 */
function injectBeforeBodyEnd(html, injection) {
  if (!html) return injection;
  const m = html.match(/<\/body\s*>/i);
  if (m) {
    return html.slice(0, m.index) + injection + html.slice(m.index);
  }
  return html + injection;
}

/**
 * Set the standard /go-response cookies on every render path (offer, safe, paused,
 * gate-short-circuited). Without this, only the main "filter chain ran" path
 * gets the bg_cid cookie, which means:
 *   - The heartbeat script can't run (it bails when bg_cid is missing)
 *   - The visitor doesn't appear in /admin/live
 *   - Cross-campaign attribution breaks (no fresh click_id assigned)
 *
 * Sets:
 *   - bg_cid: the click_id for this visit (read by heartbeat + auto-conv runtime)
 *   - clears bg_conv: so each new ad click can convert (per-click-id dedup)
 */
function setGoCookies(req, res, doc) {
  res.cookie(CLICK_COOKIE, doc.click_id, {
    maxAge: CLICK_COOKIE_MAX_AGE,
    httpOnly: false,
    sameSite: 'lax',
    secure: req.secure,
  });
  res.clearCookie('bg_conv', {
    path: '/',
    sameSite: 'lax',
    secure: req.secure,
    httpOnly: false,
  });
}

/**
 * Apply workspace-level tracking + live heartbeat to any page response.
 * Runs on BOTH offer pages and safe pages so the client gets recordings AND
 * presence info for every visitor.
 *
 * - Heartbeat: ALWAYS injected (small, presence is core to /admin/live)
 * - Clarity: injected only if workspace has clarity_project_id set
 */
/**
 * Wrap landing-page HTML with both presence/analytics tracking AND the
 * WordPress fingerprint surface.
 *
 * Runs on every /go response - offer pages, safe pages, gate-blocked stubs,
 * and the renderSafeFallback() output. By centralizing the HTML mutations
 * here we guarantee a uniform fingerprint across the whole campaign surface,
 * so a crawler that hits one URL forms a "this is WordPress" opinion that
 * won't be contradicted by hitting another URL on the same domain.
 *
 * - WP fingerprint meta: ALWAYS injected (3 small <meta>/<link> tags in <head>)
 * - Heartbeat: ALWAYS injected (small, presence is core to /admin/live)
 * - Clarity: injected only if workspace has clarity_project_id set
 */
function applyPageTracking(html, workspace) {
  // Inject WP fingerprint meta tags into <head>. Idempotent on already-WP
  // pages (a duplicate generator tag is harmless; fingerprinters take the
  // first-seen value). Returns input unchanged if html is empty.
  let out = injectWpMeta(html);

  // Always inject heartbeat - it's tiny (~700 bytes) and powers /admin/live
  out = injectBeforeBodyEnd(out, buildHeartbeatInjection());

  // Clarity is workspace-scoped and optional
  const trackingId = workspace?.settings?.tracking?.clarity_project_id;
  if (trackingId) {
    const injection = buildTrackingInjection({ clarityProjectId: trackingId });
    if (injection) out = injectBeforeBodyEnd(out, injection);
  }
  return out;
}

/**
 * Register the visitor with the in-memory live presence tracker.
 * Called from every /go render path (offer page, safe page, gate short-circuits).
 *
 * The dashboard uses this to show "who's on my pages right now". The visitor's
 * heartbeat script (injected via applyPageTracking) will keep them alive in
 * the tracker until they navigate away or the heartbeat goes stale.
 */
function registerLiveVisitor(doc, campaign, workspace) {
  if (!doc || !doc.click_id) return;
  try {
    live.arrived({
      click_id: doc.click_id,
      workspace_id: workspace?._id,
      campaign_id: campaign?._id,
      campaign_name: campaign?.name,
      campaign_slug: campaign?.slug,
      page_type: doc.page_rendered,
      ip: doc.ip,
      country: doc.country,
      country_name: doc.country_name,
      asn_org: doc.asn_org,
      is_proxy: doc.is_proxy,
      proxy_type: doc.proxy_type,
      ip_type: doc.ip_type,
      device_label: doc.ua_parsed?.device_label || doc.ua_parsed?.device_type,
      in_app_browser: doc.in_app_browser,
      utm: doc.utm,
      decision: doc.decision,
    });
  } catch (err) {
    // Live presence is best-effort - never let it break a /go response
    logger.warn('live_presence_register_failed', { err: err.message });
  }
}

/**
 * Set headers that prevent caching at every layer:
 *   - Browser: must-revalidate, no-store
 *   - Cloudflare: CDN-Cache-Control: no-store overrides any cache rule
 *   - Other CDNs: Surrogate-Control header for Fastly/Varnish
 *
 * Apply to every /go response and gate-blocked safe-page response.
 */
/**
 * Headers applied to every campaign render (offer page, safe page, gate stubs).
 *
 * - Cache busting: campaigns must never be cached (different visitor = different
 *   variant, different conversion state, etc.)
 * - X-Robots-Tag noindex: only set when the campaign is NOT indexable. For
 *   indexable campaigns we omit it so crawlers can index the URL freely.
 * - X-Pingback: WordPress fingerprint - present on every response regardless
 *   of indexable status; matches what a normal WP site emits.
 *
 * Pass `campaign` so we can read `campaign.indexable`. Backwards-compatible:
 * if campaign is omitted (e.g. error responses where we don't have one),
 * defaults to noindex (the safe option).
 */
function setNoCacheHeaders(req, res, campaign) {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('Surrogate-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  // Default to noindex; only opt-in indexable campaigns skip this header.
  // The header is the second line of defense alongside robots.txt - even
  // if a crawler ignores robots.txt or the URL leaks, this header tells
  // them not to index. See campaigns.indexable in models/Campaign.js.
  if (!campaign || !campaign.indexable) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  }
  // WordPress fingerprint: every WP install sends X-Pingback on frontend
  // page responses. Including it here gives campaign URLs the same surface
  // signal as our public site pages, so the whole domain looks WP-shaped.
  setPingbackHeader(req, res);
}

function renderSafeFallback() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Page not available</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;margin:80px auto;padding:0 20px;text-align:center;color:#666}</style>
</head><body><h1>Page not available</h1><p>This page is not available in your region.</p></body></html>`;
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = router;
module.exports.handleClick = handleClick;
