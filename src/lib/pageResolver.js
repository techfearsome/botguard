const { LandingPage } = require('../models');

/**
 * Resolve which landing page to render for a given click.
 *
 * @param {object} campaign - the campaign document
 * @param {string} deviceClass - 'iphone'|'android'|'windows'|'mac'|'linux'|'other'
 * @param {'offer'|'safe'} kind - which page kind to fetch
 * @returns {Promise<LandingPage|null>}
 *
 * Resolution order:
 *   1. campaign.device_pages[deviceClass][kind] - per-device override
 *   2. campaign.landing_page_id (for offer) or campaign.safe_page_id (for safe)
 *   3. null (caller falls back to stub / built-in safe page)
 */
async function resolvePageForDevice(campaign, deviceClass, kind) {
  if (!campaign) return null;

  const deviceMap = campaign.device_pages || {};
  const deviceEntry = deviceMap[deviceClass] || {};
  const deviceOverrideId = deviceEntry[kind];

  if (deviceOverrideId) {
    const page = await LandingPage.findById(deviceOverrideId);
    if (page) return page;
    // Page was deleted - fall through to default
  }

  const fallbackId = kind === 'offer' ? campaign.landing_page_id : campaign.safe_page_id;
  if (!fallbackId) return null;

  return LandingPage.findById(fallbackId);
}

module.exports = { resolvePageForDevice };
