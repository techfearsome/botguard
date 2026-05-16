/**
 * Cloudflare KV sync — pushes active CloudflareRules to Workers KV.
 *
 * Environment variables:
 *   CF_ACCOUNT_ID       — Cloudflare account ID
 *   CF_API_TOKEN        — API token with "Account.Workers KV Storage:Edit" permission
 *   CF_KV_NAMESPACE_ID  — KV namespace ID (from the Cloudflare dashboard)
 *
 * That's it. No other Cloudflare config needed.
 */

'use strict';

const logger = require('./logger');

/**
 * Build the blocklist payload from active CloudflareRules.
 * Includes the scan mode and enabled state so the Worker knows
 * how to behave without needing a separate config push.
 */
async function buildBlocklist(workspaceId) {
  const CloudflareRule = require('../models/CloudflareRule');
  const { Workspace } = require('../models');

  const ws = await Workspace.findById(workspaceId).lean();

  const rules = await CloudflareRule.find({
    workspace_id: workspaceId,
    active: true,
  }).lean();

  const cidrs = [];
  const ips = [];
  const asns = [];

  for (const r of rules) {
    const entry = {
      id: r._id.toString(),
      action: r.action || 'block',
      label: r.label || '',
    };

    if (r.rule_type === 'cidr') {
      cidrs.push({ ...entry, cidr: r.value });
    } else if (r.rule_type === 'ip') {
      ips.push({ ...entry, ip: r.value });
    } else if (r.rule_type === 'asn') {
      asns.push({ ...entry, asn: r.asn_number });
    }
  }

  // Read worker config from workspace settings (or defaults)
  const cfSettings = ws?.cloudflare_settings || {};

  return {
    version: Date.now(),
    updated_at: new Date().toISOString(),
    total_rules: rules.length,
    // Worker behaviour controls
    enabled: cfSettings.enabled !== false,     // default: enabled
    scan_mode: cfSettings.scan_mode || 'utm',  // 'all' or 'utm'
    cidrs,
    ips,
    asns,
  };
}

/**
 * Push the blocklist to Cloudflare Workers KV.
 * Single KV write — costs 1 write operation.
 */
async function syncToCloudflareKV(workspaceId) {
  const CF_ACCOUNT_ID      = process.env.CF_ACCOUNT_ID;
  const CF_API_TOKEN       = process.env.CF_API_TOKEN;
  const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;

  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_KV_NAMESPACE_ID) {
    logger.warn('cf_sync_skip', { reason: 'Missing CF_ACCOUNT_ID, CF_API_TOKEN, or CF_KV_NAMESPACE_ID' });
    return { success: false, reason: 'missing_config' };
  }

  const blocklist = await buildBlocklist(workspaceId);
  const payload = JSON.stringify(blocklist);

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/blocklist`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: payload,
  });

  const result = await res.json();

  if (result.success) {
    const CloudflareRule = require('../models/CloudflareRule');
    await CloudflareRule.updateMany(
      { workspace_id: workspaceId, active: true, needs_sync: true },
      { $set: { synced_at: new Date(), needs_sync: false } }
    );

    logger.info('cf_sync_success', {
      rules: blocklist.total_rules,
      cidrs: blocklist.cidrs.length,
      ips: blocklist.ips.length,
      asns: blocklist.asns.length,
      payload_bytes: payload.length,
      scan_mode: blocklist.scan_mode,
      enabled: blocklist.enabled,
    });

    return { success: true, rules: blocklist.total_rules, payload_bytes: payload.length };
  } else {
    logger.warn('cf_sync_failed', { errors: result.errors });
    return { success: false, errors: result.errors };
  }
}

module.exports = { buildBlocklist, syncToCloudflareKV };
