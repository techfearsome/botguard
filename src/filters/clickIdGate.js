/**
 * Click Identifier gate filter.
 *
 * Every legitimate ad click carries a platform click identifier that the ad
 * network auto-appends at click time:
 *
 *   Google Ads:  gclid  (standard — desktop, Android, consented iOS)
 *                wbraid (iOS in-app ad → web destination)
 *                gbraid (iOS web ad → app destination)
 *   Bing Ads:    msclkid
 *
 * A visitor arriving with valid UTMs but NO click identifier is suspicious:
 *   - Someone copied/pasted the URL (the click ID doesn't survive copying)
 *   - A scraper harvested the link from the wild
 *   - A bot is replaying a crafted URL without a real click
 *   - Auto-tagging was stripped by an intermediary
 *
 * When enabled, a visit missing ALL accepted click identifiers is routed to
 * the safe page. Runs BEFORE scoring — a hard block, like the UTM gate.
 *
 * Configurable which identifiers count as valid (default: any Google or Bing).
 *
 * Returns:
 *   {
 *     blocked: bool,
 *     flags: [...],
 *   }
 */

'use strict';

// Map friendly config names to the external_ids field names
const ID_FIELDS = {
  gclid: 'gclid',
  wbraid: 'wbraid',
  gbraid: 'gbraid',
  msclkid: 'msclkid',
};

function clickIdGateCheck({ externalIds = {}, campaign }) {
  const gate = campaign?.filter_config?.clickid_gate;
  if (!gate || !gate.enabled) {
    return { blocked: false, flags: ['clickid_gate_off'] };
  }

  // Which identifiers are accepted for this campaign.
  // Default: any Google click ID (gclid/wbraid/gbraid). Bing optional.
  const accepted = Array.isArray(gate.accepted_ids) && gate.accepted_ids.length > 0
    ? gate.accepted_ids
    : ['gclid', 'wbraid', 'gbraid'];

  // Check if the visitor has at least one accepted, non-empty identifier
  let foundId = null;
  for (const idName of accepted) {
    const field = ID_FIELDS[idName];
    if (!field) continue;
    const value = externalIds?.[field];
    if (value && typeof value === 'string' && value.trim()) {
      foundId = idName;
      break;
    }
  }

  if (foundId) {
    return { blocked: false, flags: ['clickid_gate_pass', `clickid_${foundId}`] };
  }

  return {
    blocked: true,
    flags: ['clickid_gate_fail', 'clickid_missing'],
  };
}

module.exports = { clickIdGateCheck };
