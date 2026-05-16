/**
 * Worker Deploy Service — auto-deploys the BotGuard edge firewall Worker.
 *
 * Env vars: CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID, CF_SYNC_KEY
 */

'use strict';

const logger = require('./logger');
const CF_API = 'https://api.cloudflare.com/client/v4';

function getConfig() {
  return {
    accountId:     process.env.CF_ACCOUNT_ID,
    apiToken:      process.env.CF_API_TOKEN,
    kvNamespaceId: process.env.CF_KV_NAMESPACE_ID,
    syncKey:       process.env.CF_SYNC_KEY || '',
  };
}

/**
 * Generate the Worker script with log endpoint and key baked in.
 */
function generateWorkerScript(logEndpoint, logKey) {
  const LOG_EP = logEndpoint || '';
  const LOG_K  = logKey || '';

  // The Worker script as a template string.
  // Uses ES module syntax (export default) for KV binding support.
  const script = [
    '/**',
    ' * BotGuard Edge Firewall Worker',
    ' * Auto-deployed — do not edit manually.',
    ' * Generated: ' + new Date().toISOString(),
    ' */',
    '',
    'const LOG_ENDPOINT = "' + LOG_EP + '";',
    'const LOG_KEY = "' + LOG_K + '";',
    '',
    'let cached = { config: null, cidrs: null, ips: null, asns: null };',
    'let cacheExpiry = 0;',
    'const CACHE_TTL_MS = 5 * 60 * 1000;',
    '',
    'async function getBlocklist(env) {',
    '  const now = Date.now();',
    '  if (cached.config && now < cacheExpiry) return cached;',
    '  try {',
    '    const [config, cidrs, ips, asns] = await Promise.all([',
    '      env.BLOCKLIST.get("config", { type: "json" }),',
    '      env.BLOCKLIST.get("cidrs", { type: "json" }),',
    '      env.BLOCKLIST.get("ips", { type: "json" }),',
    '      env.BLOCKLIST.get("asns", { type: "json" }),',
    '    ]);',
    '    if (config) {',
    '      cached = { config, cidrs: cidrs || [], ips: ips || [], asns: asns || [] };',
    '      cacheExpiry = now + CACHE_TTL_MS;',
    '    }',
    '  } catch (e) {}',
    '  return cached;',
    '}',
    '',
    'function ipv4ToInt(ip) {',
    '  const p = ip.split(".");',
    '  if (p.length !== 4) return null;',
    '  return ((parseInt(p[0]) << 24) | (parseInt(p[1]) << 16) |',
    '          (parseInt(p[2]) << 8) | parseInt(p[3])) >>> 0;',
    '}',
    '',
    'function ipv4InCidr(ip, cidr) {',
    '  const [range, bits] = cidr.split("/");',
    '  const mask = bits ? (~0 << (32 - parseInt(bits))) >>> 0 : 0xFFFFFFFF;',
    '  const a = ipv4ToInt(ip), b = ipv4ToInt(range);',
    '  if (a === null || b === null) return false;',
    '  return (a & mask) === (b & mask);',
    '}',
    '',
    'function expandIPv6(ip) {',
    '  let parts = ip.split(":");',
    '  const ei = parts.indexOf("");',
    '  if (ei !== -1) {',
    '    const head = parts.slice(0, ei);',
    '    const tail = parts.slice(ei + 1).filter(p => p !== "");',
    '    parts = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];',
    '  }',
    '  return parts.map(p => p.padStart(4, "0")).join(":");',
    '}',
    '',
    'function ipv6InCidr(ip, cidr) {',
    '  const [range, bitsStr] = cidr.split("/");',
    '  const bits = parseInt(bitsStr || "128");',
    '  const n = Math.ceil(bits / 4);',
    '  return expandIPv6(ip).replace(/:/g, "").substring(0, n) ===',
    '         expandIPv6(range).replace(/:/g, "").substring(0, n);',
    '}',
    '',
    'function checkIP(ip, bl, asn) {',
    '  if (!bl || !ip) return null;',
    '  const v6 = ip.includes(":");',
    '  if (bl.ips) for (const r of bl.ips) {',
    '    if (r.ip === ip) return { action: r.action || "block", reason: "ip", matched: r.ip };',
    '  }',
    '  if (bl.cidrs) for (const r of bl.cidrs) {',
    '    if (!r.cidr) continue;',
    '    if (v6 && r.cidr.includes(":") && ipv6InCidr(ip, r.cidr))',
    '      return { action: r.action || "block", reason: "cidr", matched: r.cidr };',
    '    if (!v6 && !r.cidr.includes(":") && ipv4InCidr(ip, r.cidr))',
    '      return { action: r.action || "block", reason: "cidr", matched: r.cidr };',
    '  }',
    '  if (asn && bl.asns) for (const r of bl.asns) {',
    '    if (r.asn === asn) return { action: r.action || "block", reason: "asn", matched: "AS" + r.asn };',
    '  }',
    '  return null;',
    '}',
    '',
    'const UTM_PARAMS = ["utm_source","utm_medium","utm_campaign","utm_term",',
    '  "utm_content","gclid","wbraid","gbraid","fbclid","msclkid"];',
    '',
    'function hasUTM(url) {',
    '  const p = url.searchParams;',
    '  for (const k of UTM_PARAMS) if (p.has(k)) return true;',
    '  return false;',
    '}',
    '',
    'async function sendLog(data) {',
    '  if (!LOG_ENDPOINT || !LOG_KEY) return;',
    '  try {',
    '    await fetch(LOG_ENDPOINT, {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json", "x-botguard-key": LOG_KEY },',
    '      body: JSON.stringify(data),',
    '    });',
    '  } catch (e) {}',
    '}',
    '',
    'export default {',
    '  async fetch(request, env, ctx) {',
    '    const start = Date.now();',
    '    const url = new URL(request.url);',
    '',
    '    if (url.pathname === "/__botguard_health") {',
    '      return new Response(JSON.stringify({ status: "active", ts: new Date().toISOString() }), {',
    '        headers: { "Content-Type": "application/json" }',
    '      });',
    '    }',
    '',
    '    if (url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/")) return fetch(request);',
    '',
    '    const ip = request.headers.get("cf-connecting-ip");',
    '    const cf = request.cf || {};',
    '    const asn = cf.asn ? Number(cf.asn) : null;',
    '    const bl = await getBlocklist(env);',
    '',
    '    if (!bl.config || !bl.config.enabled) return fetch(request);',
    '    if (bl.config.scan_mode === "utm" && !hasUTM(url)) return fetch(request);',
    '',
    '    const result = checkIP(ip, bl, asn);',
    '    const action = result ? result.action : "allow";',
    '    const reason = result ? result.reason : "no_match";',
    '    const matched = result ? result.matched : "";',
    '',
    '    const logData = {',
    '      ip, asn, country: cf.country || "",',
    '      user_agent: request.headers.get("user-agent") || "",',
    '      url: url.pathname + url.search, method: request.method,',
    '      action, reason, matched_rule: matched,',
    '      scan_mode: bl.config.scan_mode,',
    '      processing_ms: Date.now() - start,',
    '    };',
    '    ctx.waitUntil(sendLog(logData));',
    '',
    '    if (action === "block") {',
    '      return new Response(',
    '        "<!DOCTYPE html><html><head><title>Error</title></head><body><h1>520</h1><p>Web server is returning an unknown error</p></body></html>",',
    '        { status: 520, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }',
    '      );',
    '    }',
    '',
    '    return fetch(request);',
    '  }',
    '};',
  ].join('\n');

  return script;
}

// ── Cloudflare API helpers ───────────────────────────────────────────

function cfHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function cfFetch(path, token, opts) {
  opts = opts || {};
  const res = await fetch(CF_API + path, Object.assign({}, opts, {
    headers: Object.assign({}, cfHeaders(token), opts.headers || {}),
  }));
  return res.json();
}

async function getZoneId(domain, token) {
  const parts = domain.split('.');
  const root = parts.slice(-2).join('.');
  const data = await cfFetch('/zones?name=' + root, token);
  if (!data.success || !data.result || !data.result.length) {
    throw new Error('Zone not found for ' + domain);
  }
  return data.result[0].id;
}

async function uploadWorkerScript(accountId, workerName, script, kvNamespaceId, token) {
  const metadata = {
    main_module: 'worker.js',
    bindings: [{ type: 'kv_namespace', name: 'BLOCKLIST', namespace_id: kvNamespaceId }],
    compatibility_date: '2024-01-01',
  };

  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');

  const res = await fetch(
    CF_API + '/accounts/' + accountId + '/workers/scripts/' + workerName,
    { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token }, body: formData }
  );

  const data = await res.json();
  if (!data.success) {
    throw new Error('Worker upload failed: ' + (data.errors && data.errors[0] ? data.errors[0].message : 'Unknown'));
  }
  return data;
}

async function setupRoute(zoneId, workerName, domain, token) {
  const pattern = domain + '/*';
  const existing = await cfFetch('/zones/' + zoneId + '/workers/routes', token);
  if (existing.success && existing.result) {
    const found = existing.result.find(function(r) { return r.pattern === pattern; });
    if (found) {
      await cfFetch('/zones/' + zoneId + '/workers/routes/' + found.id, token, {
        method: 'PUT', body: JSON.stringify({ pattern: pattern, script: workerName }),
      });
      return found.id;
    }
  }
  const data = await cfFetch('/zones/' + zoneId + '/workers/routes', token, {
    method: 'POST', body: JSON.stringify({ pattern: pattern, script: workerName }),
  });
  if (!data.success) {
    throw new Error('Route creation failed: ' + (data.errors && data.errors[0] ? data.errors[0].message : 'Unknown'));
  }
  return data.result.id;
}

async function deleteWorker(accountId, workerName, token) {
  const res = await fetch(CF_API + '/accounts/' + accountId + '/workers/scripts/' + workerName, {
    method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token },
  });
  return res.ok;
}

async function deleteRoute(zoneId, routeId, token) {
  const res = await fetch(CF_API + '/zones/' + zoneId + '/workers/routes/' + routeId, {
    method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token },
  });
  return res.ok;
}

async function workerExists(accountId, workerName, token) {
  const res = await fetch(CF_API + '/accounts/' + accountId + '/workers/scripts/' + workerName, {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  return res.ok;
}

// ── Public API ───────────────────────────────────────────────────────

async function deployWorker(domain, serverUrl) {
  const cfg = getConfig();
  if (!cfg.accountId || !cfg.apiToken || !cfg.kvNamespaceId) {
    throw new Error('Missing CF_ACCOUNT_ID, CF_API_TOKEN, or CF_KV_NAMESPACE_ID');
  }

  const workerName = 'botguard-' + domain.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 50);
  const logEndpoint = (serverUrl || '').replace(/\/$/, '') + '/admin/cloudflare/api/log';

  const zoneId = await getZoneId(domain, cfg.apiToken);
  logger.info('cf_deploy_zone', { domain: domain, zoneId: zoneId });

  const script = generateWorkerScript(logEndpoint, cfg.syncKey);
  await uploadWorkerScript(cfg.accountId, workerName, script, cfg.kvNamespaceId, cfg.apiToken);
  logger.info('cf_deploy_script', { workerName: workerName });

  const routeId = await setupRoute(zoneId, workerName, domain, cfg.apiToken);
  logger.info('cf_deploy_route', { pattern: domain + '/*', routeId: routeId });

  return { success: true, workerName: workerName, routeId: routeId, zoneId: zoneId };
}

async function undeployWorker(domain, workerName, zoneId, routeId) {
  const cfg = getConfig();
  if (!cfg.accountId || !cfg.apiToken) throw new Error('Missing Cloudflare credentials');

  if (routeId && zoneId) {
    try { await deleteRoute(zoneId, routeId, cfg.apiToken); } catch (e) {
      logger.warn('cf_undeploy_route_err', { err: e.message });
    }
  }
  if (workerName) {
    await deleteWorker(cfg.accountId, workerName, cfg.apiToken);
  }
  logger.info('cf_undeploy_done', { domain: domain, workerName: workerName });
  return { success: true };
}

async function verifyDeployment(workerName) {
  const cfg = getConfig();
  if (!cfg.accountId || !cfg.apiToken || !workerName) return { deployed: false };
  const exists = await workerExists(cfg.accountId, workerName, cfg.apiToken);
  return { deployed: exists, workerName: workerName };
}

module.exports = { deployWorker, undeployWorker, verifyDeployment, generateWorkerScript };
