/**
 * guardEligibility.js — Decide whether a click runs through the Level 2 bot
 * guard, and with what config.
 *
 * Precedence:
 *   1. CAMPAIGN-level bot_guard (filter_config.bot_guard) with per-device
 *      targeting. When enabled, only device classes listed in `devices` are
 *      challenged; everything else skips Level 2. An empty `devices` list with
 *      enabled=true means "all devices".
 *   2. Legacy PAGE-level bot_guard (targetPage.bot_guard) — kept so existing
 *      setups keep working until they migrate to the campaign toggle.
 *
 * Returns a normalized, plain config object when the guard SHOULD run for this
 * device (safe to embed in the signed guard token), or null when it should be
 * skipped.
 */

'use strict';

const { ALL_DEVICE_CLASSES } = require('./deviceClass');

function normalizeConfig(cfg, source) {
  // Accept plain objects (lean queries) or mongoose subdocs.
  const c = cfg && typeof cfg.toObject === 'function' ? cfg.toObject() : cfg || {};
  return {
    enabled: true,
    source, // 'campaign' | 'page' — for logging / debugging only
    check_timezone: c.check_timezone !== false,
    check_interaction: c.check_interaction !== false,
    check_dwell: c.check_dwell !== false,
    min_dwell_ms: Math.max(1000, Math.min(10000, parseInt(c.min_dwell_ms, 10) || 2000)),
    check_webgl: c.check_webgl === true,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.campaign      — campaign doc (lean or hydrated)
 * @param {object} opts.targetPage    — the page about to be served
 * @param {string} opts.deviceClass   — 'iphone'|'android'|'windows'|'mac'|'linux'|'other'
 * @returns {object|null} normalized guard config, or null to skip the guard
 */
function resolveGuardConfig({ campaign, targetPage, deviceClass }) {
  const campaignGuard = campaign && campaign.filter_config && campaign.filter_config.bot_guard;

  if (campaignGuard && campaignGuard.enabled) {
    const devices =
      Array.isArray(campaignGuard.devices) && campaignGuard.devices.length
        ? campaignGuard.devices
        : ALL_DEVICE_CLASSES; // empty allowlist = challenge every device
    if (!devices.includes(deviceClass)) return null; // this device opted out
    return normalizeConfig(campaignGuard, 'campaign');
  }

  // Legacy page-level guard (no device targeting — challenges all devices).
  if (targetPage && targetPage.bot_guard && targetPage.bot_guard.enabled) {
    return normalizeConfig(targetPage.bot_guard, 'page');
  }

  return null;
}

module.exports = { resolveGuardConfig, normalizeConfig };
