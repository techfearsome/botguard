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
  fbclid: 'fbclid',       // Facebook / Instagram
  ttclid: 'ttclid',       // TikTok
  li_fat_id: 'li_fat_id', // LinkedIn
  twclid: 'twclid',       // Twitter / X
  rdt_cid: 'rdt_cid',     // Reddit
};

function clickIdGateCheck({ externalIds = {}, campaign }) {
  const gate = campaign?.filter_config?.clickid_gate;
  if (!gate || !gate.enabled) {
    return { blocked: false, flags: ['clickid_gate_off'] };
  }

  // Which identifiers are accepted for this campaign.
  const accepted = Array.isArray(gate.accepted_ids) && gate.accepted_ids.length > 0
    ? gate.accepted_ids
    : ['gclid', 'wbraid', 'gbraid'];

  // Format validation level: 'off' | 'loose' | 'strict' (default 'off' for
  // backward compatibility — presence-only unless the campaign opts in).
  const validateLevel = gate.validate_format || 'off';

  const { validateClickId } = require('./clickIdValidate');

  // Check if the visitor has at least one accepted, non-empty identifier
  let foundId = null;
  let foundValue = null;
  let invalidFormat = null;

  for (const idName of accepted) {
    const field = ID_FIELDS[idName];
    if (!field) continue;
    const value = externalIds?.[field];
    if (value && typeof value === 'string' && value.trim()) {
      // Present. If format validation is on, check it.
      if (validateLevel !== 'off') {
        const check = validateClickId(idName, value, validateLevel);
        if (!check.valid) {
          // ID present but malformed — remember it, keep looking for a valid one
          invalidFormat = { id: idName, reason: check.reason };
          continue;
        }
      }
      foundId = idName;
      foundValue = value;
      break;
    }
  }

  if (foundId) {
    return { blocked: false, flags: ['clickid_gate_pass', `clickid_${foundId}`] };
  }

  // No valid ID found. Distinguish "missing entirely" from "present but fake".
  if (invalidFormat) {
    return {
      blocked: true,
      flags: ['clickid_gate_fail', 'clickid_invalid_format', `clickid_${invalidFormat.id}_${invalidFormat.reason}`],
    };
  }

  return {
    blocked: true,
    flags: ['clickid_gate_fail', 'clickid_missing'],
  };
}

module.exports = { clickIdGateCheck };
