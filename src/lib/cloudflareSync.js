/**
 * Cloudflare KV sync — pushes active CloudflareRules to Workers KV.
 *
 * Key structure in KV:
 *   "config"  — { enabled, scan_mode, version, updated_at }
 *   "cidrs"   — [ { cidr, action, label }, ... ]
 *   "ips"     — [ { ip, action, label }, ... ]
 *   "asns"    — [ { asn, action, label }, ... ]
 *
 * 4 KV writes per sync (4 of the 1,000/day free limit).
 * Each key is independently readable and debuggable in the CF dashboard.
 *
 * Env vars: CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
 */

'use strict';

const logger = require('./logger');

function kvUrl(key) {
  const acct = process.env.CF_ACCOUNT_ID;
  const ns   = process.env.CF_KV_NAMESPACE_ID;
  return `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${ns}/values/${key}`;
}

function kvHeaders() {
  return {
    'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
    'Content-Type': 'text/plain',
  };
}

async function writeKV(key, data) {
  const res = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: kvHeaders(),
    body: JSON.stringify(data),
  });
  const result = await res.json();
  if (!result.success) {
    throw new Error(`KV write "${key}" failed: ${result.errors?.[0]?.message || 'unknown'}`);
  }
  return result;
}

/**
 * Build all payloads from active CloudflareRules.
 */
async function buildBlocklist(workspaceId) {
  const CloudflareRule = require('../models/CloudflareRule');
  const { Workspace } = require('../models');

  const ws = await Workspace.findById(workspaceId).lean();
  const cfSettings = ws?.settings?.cloudflare_settings || {};

  const rules = await CloudflareRule.find({
    workspace_id: workspaceId,
    active: true,
  }).lean();

  const cidrs = [];
  const ips = [];
  const asns = [];

  for (const r of rules) {
    const entry = { action: r.action || 'block', label: r.label || '' };
    if (r.rule_type === 'cidr') {
      cidrs.push({ ...entry, cidr: r.value });
    } else if (r.rule_type === 'ip') {
      ips.push({ ...entry, ip: r.value });
    } else if (r.rule_type === 'asn') {
      asns.push({ ...entry, asn: r.asn_number });
    }
  }

  const config = {
    enabled: cfSettings.enabled !== false,
    scan_mode: cfSettings.scan_mode || 'utm',
    version: Date.now(),
    updated_at: new Date().toISOString(),
    total_rules: rules.length,
    counts: { cidrs: cidrs.length, ips: ips.length, asns: asns.length },
  };

  return { config, cidrs, ips, asns };
}

/**
 * Push all keys to Cloudflare KV.
 * 4 writes: config + cidrs + ips + asns.
 */
async function syncToCloudflareKV(workspaceId) {
  if (!process.env.CF_ACCOUNT_ID || !process.env.CF_API_TOKEN || !process.env.CF_KV_NAMESPACE_ID) {
    logger.warn('cf_sync_skip', { reason: 'Missing CF env vars' });
    return { success: false, reason: 'missing_config' };
  }

  const data = await buildBlocklist(workspaceId);

  // Write each key separately — 4 writes
  await writeKV('config', data.config);
  await writeKV('cidrs', data.cidrs);
  await writeKV('ips', data.ips);
  await writeKV('asns', data.asns);

  // Mark rules as synced
  const CloudflareRule = require('../models/CloudflareRule');
  await CloudflareRule.updateMany(
    { workspace_id: workspaceId, active: true, needs_sync: true },
    { $set: { synced_at: new Date(), needs_sync: false } }
  );

  const totalRules = data.config.total_rules;
  const totalBytes = JSON.stringify(data.config).length +
    JSON.stringify(data.cidrs).length +
    JSON.stringify(data.ips).length +
    JSON.stringify(data.asns).length;

  logger.info('cf_sync_success', {
    rules: totalRules,
    cidrs: data.cidrs.length,
    ips: data.ips.length,
    asns: data.asns.length,
    total_bytes: totalBytes,
  });

  return { success: true, rules: totalRules, payload_bytes: totalBytes };
}

module.exports = { buildBlocklist, syncToCloudflareKV };
