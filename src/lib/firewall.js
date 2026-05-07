/**
 * Firewall ledger writer.
 *
 * Called from src/lib/click.js whenever we write a Click whose decision is
 * 'block' or 'would_block' AND the reason classifies as a fraud signal
 * (see FirewallEntry.classify). The write is fire-and-forget - we never
 * await it from the request path because slow Mongo writes must not slow
 * down visitor responses.
 *
 * Upsert semantics:
 *   - First sighting of an IP: create the document with hit_count=1
 *   - Repeat sighting: increment hit_count, update last_seen + last_*
 *     fields, and add the new reason/class if not already present
 *
 * IP normalization:
 *   - We store IPs verbatim as the request reported them (after
 *     trust_proxy / Cloudflare CF-Connecting-IP unwrapping).
 *   - IPv6 is stored as-is. Google Ads accepts IPv6 in exclusion lists.
 *   - We don't dedupe across IPv4/IPv6 of the same host - that's a
 *     non-trivial mapping problem and Google Ads needs both forms anyway.
 */

const FirewallEntry = require('../models/FirewallEntry');
const logger = require('./logger');

// Cap on the reasons array to bound document size. A bot that hits us in
// 1000 different ways is unusual and capping is defensive, not exact.
const MAX_REASONS_PER_ENTRY = 50;

/**
 * Record a flagged IP. Fire-and-forget; errors are logged but not thrown.
 *
 * @param {object} click - the Click document we're about to persist
 * @param {object} extras - optional fields not on Click
 * @param {string} [extras.asn] - ASN provider name from ProxyCheck
 */
async function recordFirewallEntry(click, extras = {}) {
  try {
    if (!click || !click.workspace_id || !click.ip || !click.decision_reason) {
      return;
    }
    // Don't record allowed clicks. Filter chain decided this IP is fine.
    if (click.decision === 'allow') return;

    const reasonClass = FirewallEntry.classify(click.decision_reason);
    if (!reasonClass) return;       // excluded category (country, UTM, etc.)

    const now = new Date();
    const update = {
      $setOnInsert: {
        workspace_id: click.workspace_id,
        ip: click.ip,
        first_seen: now,
        reviewed: false,
      },
      $set: {
        last_seen: now,
        last_device: click.device_label || click.device_class || '',
        last_country: click.country || '',
        last_asn: extras.asn || '',
        last_user_agent: (click.user_agent || '').slice(0, 500),
        last_campaign_slug: click.campaign_slug || '',
      },
      $inc: { hit_count: 1 },
      $addToSet: {
        // Only add the reason if it's not already in the array. $addToSet
        // gives us idempotent reason accumulation across repeat hits.
        reasons: { $each: [click.decision_reason].slice(0, MAX_REASONS_PER_ENTRY) },
        reason_classes: reasonClass,
      },
    };

    await FirewallEntry.updateOne(
      { workspace_id: click.workspace_id, ip: click.ip },
      update,
      { upsert: true }
    );
  } catch (err) {
    // Duplicate-key race on concurrent first-sighting: harmless, retry once.
    if (err && err.code === 11000) {
      try {
        await FirewallEntry.updateOne(
          { workspace_id: click.workspace_id, ip: click.ip },
          { $set: { last_seen: new Date() }, $inc: { hit_count: 1 } }
        );
      } catch (retryErr) {
        logger.warn('firewall_record_retry_failed', { err: retryErr.message });
      }
      return;
    }
    logger.warn('firewall_record_failed', { err: err.message });
  }
}

module.exports = { recordFirewallEntry };
