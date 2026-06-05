const { customAlphabet } = require('nanoid');
const { parseUA } = require('./uaParser');

const { Click } = require('../models');
const { getClientIp, hashIp } = require('./ip');
const { parseUtm, parseExternalIds, parseValueTrack } = require('./utm');

// 22-char URL-safe ID, ~131 bits of entropy
const generateClickId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 22
);

/**
 * Build a click document from the request.
 * Uses the unified uaParser module for all UA detection.
 */
function buildClickDoc({ req, workspace, campaign }) {
  const ip = getClientIp(req);
  const ua = req.get('user-agent') || '';
  const referer = req.get('referer') || req.get('referrer') || '';

  // Unified UA parse — automatically uses best available tier
  const parsed = parseUA(ua, req.headers);

  let refererHost = null;
  try {
    if (referer) refererHost = new URL(referer).hostname;
  } catch (_) {}

  return {
    click_id: generateClickId(),
    workspace_id: workspace._id,
    campaign_id: campaign._id,

    ts: new Date(),
    ip,
    ip_hash: hashIp(ip),

    user_agent: ua,
    ua_parsed: {
      browser: parsed.browser.name,
      browser_version: parsed.browser.version,
      browser_type: parsed.browser_type || null,
      os: parsed.os.name,
      os_version: parsed.os.version,
      device_type: parsed.device_type,
      device_label: parsed.device_label,
      device_class: parsed.device_class,
      device_vendor: parsed.device.vendor,
      device_model: parsed.device.model,
      is_bot: parsed.is_bot,
      is_known_crawler: parsed.is_known_crawler,
      is_ai_crawler: parsed.is_ai_crawler,
      bot_name: parsed.bot_name,
      bot_category: parsed.bot_category,
      is_frozen_ua: parsed.is_frozen_ua,
      hints_mismatch: parsed.hints_mismatch.length > 0 ? parsed.hints_mismatch : undefined,
    },

    referer,
    referer_host: refererHost,
    in_app_browser: parsed.in_app_browser,

    utm: parseUtm(req.query),
    external_ids: parseExternalIds(req.query),
    valuetrack: parseValueTrack(req.query),

    fingerprint: {},
    scores: {
      network: 0, headers: 0, behavior: 0, pattern: 0, referer: 0,
      total: 0,
      profile_used: campaign.source_profile,
      flags: [],
    },

    decision: 'allow',     // permissive default for week 1
    decision_reason: 'no_filters_yet',
    mode_at_decision: campaign.filter_config?.mode || 'log_only',

    page_rendered: 'offer',
  };
}

async function writeClick(doc) {
  const click = await Click.create(doc);
  // Fire-and-forget firewall ledger update. The recorder itself classifies
  // the reason and bails out for non-fraud blocks (country, UTM gates) or
  // for allowed clicks. Errors are logged inside the recorder, never thrown.
  // We don't await this - a slow firewall write must not delay the response.
  try {
    const { recordFirewallEntry } = require('./firewall');
    recordFirewallEntry(doc).catch(() => { /* logged inside */ });
  } catch (e) { /* defensive: never fail click write because of firewall */ }
  return click;
}

module.exports = { buildClickDoc, writeClick, generateClickId };
