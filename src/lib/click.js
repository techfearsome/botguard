const { customAlphabet } = require('nanoid');
const UAParser = require('ua-parser-js');

const { Click } = require('../models');
const { getClientIp, hashIp } = require('./ip');
const { parseUtm, parseExternalIds } = require('./utm');
const { detectInAppBrowser } = require('./inapp');

// 22-char URL-safe ID, ~131 bits of entropy
const generateClickId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 22
);

function classifyDevice(uaResult) {
  const deviceType = uaResult.device?.type;
  if (deviceType === 'mobile' || deviceType === 'tablet') return deviceType;
  return 'desktop';
}

function isObviousBot(ua = '') {
  if (!ua) return true;  // no UA at all is an immediate flag
  const lower = ua.toLowerCase();
  const botSignals = [
    'bot', 'crawler', 'spider', 'scraper', 'curl/', 'wget/', 'python-requests',
    'go-http-client', 'java/', 'okhttp', 'httpclient', 'phantomjs', 'headless',
    'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptime',
  ];
  return botSignals.some((s) => lower.includes(s));
}

/**
 * Build a click document from the request.
 * Network/scoring fields stay empty in week 1 — they'll be populated by the filter chain in week 2.
 */
function buildClickDoc({ req, workspace, campaign }) {
  const ip = getClientIp(req);
  const ua = req.get('user-agent') || '';
  const referer = req.get('referer') || req.get('referrer') || '';
  const parser = new UAParser(ua);
  const uaResult = parser.getResult();

  let refererHost = null;
  try {
    if (referer) refererHost = new URL(referer).hostname;
  } catch (_) {
    // bad URL, ignore
  }

  return {
    click_id: generateClickId(),
    workspace_id: workspace._id,
    campaign_id: campaign._id,

    ts: new Date(),
    ip,
    ip_hash: hashIp(ip),
    // asn / asn_org / country / region / city are populated by network filter (week 2)

    user_agent: ua,
    ua_parsed: {
      browser: uaResult.browser?.name,
      browser_version: uaResult.browser?.version,
      os: uaResult.os?.name,
      os_version: uaResult.os?.version,
      device_type: classifyDevice(uaResult),
      is_bot: isObviousBot(ua),
    },

    referer,
    referer_host: refererHost,
    in_app_browser: detectInAppBrowser(ua),

    utm: parseUtm(req.query),
    external_ids: parseExternalIds(req.query),

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
  return click;
}

module.exports = { buildClickDoc, writeClick, generateClickId };
