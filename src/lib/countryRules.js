/**
 * countryRules.js — per-country (nation-based) page and redirect overrides.
 *
 * A campaign can opt in (`country_rules_enabled`) to a list of country rules.
 * Each rule is keyed by an ISO 3166-1 alpha-2 code and can set, per device
 * class (plus an "all devices" country default):
 *   - pages[slot].offer / pages[slot].safe   → LandingPage ids
 *   - redirect_urls[slot]                    → redirect destination
 * where slot is 'default' | 'iphone' | 'android' | 'windows' | 'mac' | 'linux' | 'other'.
 *
 * Resolution (see pageResolver.js / redirect.js):
 *   country rule [device]  →  country rule [default]  →  campaign per-device  →  campaign default
 * so the campaign's existing settings always remain the fallback.
 */

'use strict';

const mongoose = require('mongoose');

// ISO 3166-1 alpha-2, plus XK (Kosovo), which IP-geo providers commonly return.
const ISO_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ ' +
  'BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM ' +
  'DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS ' +
  'GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
  'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
  'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
  'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV ' +
  'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
  'VN VU WF WS XK YE YT ZA ZM ZW'
).split(' ');
const ISO_SET = new Set(ISO_CODES);

const DEVICE_CLASSES = ['iphone', 'android', 'windows', 'mac', 'linux', 'other'];
const SLOTS = ['default', ...DEVICE_CLASSES];
const MAX_RULES = 250;

let displayNames = null;
function countryName(code) {
  try {
    if (!displayNames) displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return displayNames.of(code) || code;
  } catch (_) {
    return code;
  }
}

// [{ code, name }] sorted by name — for the admin country picker.
let cachedList = null;
function countryList() {
  if (!cachedList) {
    cachedList = ISO_CODES
      .map((code) => ({ code, name: countryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return cachedList;
}

function normalizeCountryCode(v) {
  const c = String(v || '').trim().toUpperCase();
  return ISO_SET.has(c) ? c : '';
}

/**
 * The visitor's country for rule matching. Prefers the IP-enrichment verdict
 * (doc.country — ProxyCheck/IPLocate, which already falls back to Cloudflare's
 * header). Early exits that run before enrichment (paused campaign, UTM gate,
 * click-ID gate) have no doc.country yet, so fall back to CF-IPCountry
 * directly. Cloudflare's 'XX' (unknown) and 'T1' (Tor) are not ISO codes and
 * resolve to '' (no country rule applies → campaign defaults).
 */
function visitorCountry(doc, req) {
  const fromDoc = normalizeCountryCode(doc && doc.country);
  if (fromDoc) return fromDoc;
  const h = req && req.headers ? req.headers['cf-ipcountry'] : '';
  return normalizeCountryCode(h);
}

// The enabled rule for `country`, or null. Works on lean objects and documents.
function findCountryRule(campaign, country) {
  if (!campaign || !campaign.country_rules_enabled || !country) return null;
  const cc = String(country).toUpperCase();
  const rules = Array.isArray(campaign.country_rules) ? campaign.country_rules : [];
  for (const r of rules) {
    if (r && r.enabled !== false && String(r.country || '').toUpperCase() === cc) return r;
  }
  return null;
}

const isObjectIdString = (v) =>
  typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) && mongoose.isValidObjectId(v);

/**
 * Parse the country rules JSON submitted by the campaign form.
 * Returns a clean array, or null if the payload is malformed (callers then
 * leave the stored rules untouched instead of wiping them).
 *   - unknown / duplicate country codes are dropped (first one wins)
 *   - page ids must be 24-hex ObjectIds; anything else is ignored
 *   - redirect URLs are normalized with the same helper as the campaign-level
 *     redirect URLs; runtime still validates them with isSafeRedirectUrl
 */
function parseCountryRules(raw, { normalizeUrl } = {}) {
  let arr;
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const norm = typeof normalizeUrl === 'function' ? normalizeUrl : (s) => s;

  const seen = new Set();
  const out = [];
  for (const r of arr.slice(0, MAX_RULES)) {
    if (!r || typeof r !== 'object') continue;
    const cc = normalizeCountryCode(r.country);
    if (!cc || seen.has(cc)) continue;
    seen.add(cc);

    const pages = {};
    const redirect_urls = {};
    for (const slot of SLOTS) {
      const p = r.pages && r.pages[slot];
      if (p && typeof p === 'object') {
        const entry = {};
        if (isObjectIdString(p.offer)) entry.offer = p.offer;
        if (isObjectIdString(p.safe)) entry.safe = p.safe;
        if (entry.offer || entry.safe) pages[slot] = entry;
      }
      const u = r.redirect_urls && typeof r.redirect_urls[slot] === 'string'
        ? r.redirect_urls[slot].trim().slice(0, 2048)
        : '';
      redirect_urls[slot] = u ? norm(u) : '';
    }
    out.push({ country: cc, enabled: r.enabled !== false, pages, redirect_urls });
  }
  return out;
}

module.exports = {
  ISO_CODES,
  DEVICE_CLASSES,
  SLOTS,
  countryName,
  countryList,
  normalizeCountryCode,
  visitorCountry,
  findCountryRule,
  parseCountryRules,
};
