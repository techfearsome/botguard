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
const { decide } = require('../scoring/decide');
const { DEFAULT_SLUG } = require('../lib/bootstrap');
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

async function handleClick(req, res, workspaceSlug, campaignSlug) {
  try {
    const workspace = await cache.getWorkspaceBySlug(workspaceSlug, () =>
      Workspace.findOne({ slug: workspaceSlug }).lean()
    );
    if (!workspace) return res.status(404).send('Campaign not found');

    const campaign = await cache.getCampaignBySlug(workspace._id, campaignSlug, () =>
      Campaign.findOne({
        workspace_id: workspace._id,
        slug: campaignSlug,
        status: { $ne: 'archived' },
      }).lean()
    );
    if (!campaign) return res.status(404).send('Campaign not found');

    // Build base click record
    const doc = buildClickDoc({ req, workspace, campaign });
    const deviceClass = doc.ua_parsed?.device_class || 'other';

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
      setNoCacheHeaders(res); return res.status(200).type('html').send(applyPageTracking(html, workspace));
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
      setNoCacheHeaders(res); return res.status(200).type('html').send(applyPageTracking(html, workspace));
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
      setNoCacheHeaders(res); return res.status(200).type('html').send(applyPageTracking(html, workspace));
    }
    doc.scores.flags = [...(doc.scores.flags || []), ...proxyResult.flags];

    // Handle paused campaigns
    if (campaign.status === 'paused') {
      doc.decision = 'block';
      doc.decision_reason = 'campaign_paused';
      doc.page_rendered = 'safe';
      writeClick(doc).catch((err) => logger.error('click_write_failed', { err: err.message }));
      return res.status(410).send('This campaign is currently paused.');
    }

    // Resolve which page to show (per-device override applies)
    const showSafePage = (doc.decision === 'block');
    const targetPage = await resolvePageForDevice(campaign, deviceClass, showSafePage ? 'safe' : 'offer');

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
      }
    }

    // Cookie
    res.cookie(CLICK_COOKIE, doc.click_id, {
      maxAge: CLICK_COOKIE_MAX_AGE,
      httpOnly: false,
      sameSite: 'lax',
      secure: req.secure,
    });

    // CRITICAL: never cache /go responses at any layer.
    // - Each visit must get a fresh click_id cookie
    // - Cloudflare will cache HTML by default if cookies aren't on the request
    // - 'private' tells the browser only it can cache; 's-maxage=0' tells CDNs not to
    setNoCacheHeaders(res);

    // Persist click (non-blocking)
    writeClick(doc).catch((err) => {
      logger.error('click_write_failed', { err: err.message, click_id: doc.click_id });
    });

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

router.post('/fp', express.json({ limit: '32kb' }), handleFingerprint);

// Single-tenant
router.get('/:slug', (req, res) => handleClick(req, res, DEFAULT_SLUG, req.params.slug));
// Multi-tenant
router.get('/:workspaceSlug/:campaignSlug', (req, res) =>
  handleClick(req, res, req.params.workspaceSlug, req.params.campaignSlug)
);

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
 * Apply workspace-level tracking (Microsoft Clarity, etc.) to any page response.
 * Runs on BOTH offer pages and safe pages so the client gets recordings of all traffic.
 *
 * No-op when no tracking is configured for the workspace.
 */
function applyPageTracking(html, workspace) {
  const trackingId = workspace?.settings?.tracking?.clarity_project_id;
  if (!trackingId) return html;
  const injection = buildTrackingInjection({ clarityProjectId: trackingId });
  if (!injection) return html;
  return injectBeforeBodyEnd(html, injection);
}

/**
 * Set headers that prevent caching at every layer:
 *   - Browser: must-revalidate, no-store
 *   - Cloudflare: CDN-Cache-Control: no-store overrides any cache rule
 *   - Other CDNs: Surrogate-Control header for Fastly/Varnish
 *
 * Apply to every /go response and gate-blocked safe-page response.
 */
function setNoCacheHeaders(res) {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('Surrogate-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
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
