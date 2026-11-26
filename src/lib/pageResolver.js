const { LandingPage } = require('../models');
const { findCountryRule } = require('./countryRules');

/**
 * Resolve which landing page to render for a given click.
 *
 * @param {object} campaign - the campaign document (lean or hydrated)
 * @param {string} deviceClass - 'iphone'|'android'|'windows'|'mac'|'linux'|'other'
 * @param {'offer'|'safe'} kind - which page kind to fetch
 * @param {string} [country] - visitor's ISO 3166-1 alpha-2 code (optional)
 * @returns {Promise<LandingPage|null>}
 *
 * Resolution order (first page that exists wins; a deleted page falls through):
 *   1. country rule → pages[deviceClass][kind]   (only if country rules enabled
 *   2. country rule → pages.default[kind]          and a rule matches `country`)
 *   3. campaign.device_pages[deviceClass][kind]  - per-device override
 *   4. campaign.landing_page_id (offer) / campaign.safe_page_id (safe)
 *   5. null (caller falls back to stub / built-in safe page)
 */
async function resolvePageForDevice(campaign, deviceClass, kind, country) {
  if (!campaign) return null;

  const candidates = [];
  const rule = findCountryRule(campaign, country);
  if (rule && rule.pages) {
    candidates.push(rule.pages[deviceClass] && rule.pages[deviceClass][kind]);
    candidates.push(rule.pages.default && rule.pages.default[kind]);
  }
  const deviceMap = campaign.device_pages || {};
  candidates.push(deviceMap[deviceClass] && deviceMap[deviceClass][kind]);
  candidates.push(kind === 'offer' ? campaign.landing_page_id : campaign.safe_page_id);

  const tried = new Set();
  for (const id of candidates) {
    if (!id) continue;
    const key = String(id);
    if (tried.has(key)) continue;
    tried.add(key);
    const page = await LandingPage.findById(id);
    if (page) return page;
    // Page was deleted - fall through to the next level
  }
  return null;
}

module.exports = { resolvePageForDevice };
