/**
 * Worker Deploy Service — auto-deploys the BotGuard edge firewall Worker
 * to Cloudflare via API. Creates the Worker script, binds KV, sets up
 * the domain route, and can undeploy (remove) everything cleanly.
 *
 * Requires API token with permissions:
 *   - Account > Workers Scripts: Edit
 *   - Account > Workers KV Storage: Edit
 *   - Zone > Workers Routes: Edit
 *
 * Env vars (same as cloudflareSync.js):
 *   CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
 */

'use strict';

const logger = require('./logger');
const CF_API = 'https://api.cloudflare.com/client/v4';

function getConfig() {
  return {
    accountId:    process.env.CF_ACCOUNT_ID,
    apiToken:     process.env.CF_API_TOKEN,
    kvNamespaceId: process.env.CF_KV_NAMESPACE_ID,
  };
}

function cfHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Generate the Worker script as a string.
 * The script uses the service-worker syntax (addEventListener) so it works
 * on the free plan without needing ES module support or wrangler.
 */
function generateWorkerScript() {
  // Use addEventListener syntax (not ES module export default) for
  // maximum compatibility with dashboard-deployed Workers
  return `
/**
 * BotGuard Edge Firewall Worker
 * Auto-deployed by BotGuard — do not edit manually.
 * Generated: ${new Date().toISOString()}
 */

let cachedBlocklist = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getBlocklist(env) {
  const now = Date.now();
  if (cachedBlocklist && now < cacheExpiry) return cachedBlocklist;
  try {
    const data = await env.BLOCKLIST.get('blocklist', { type: 'json' });
    if (data) { cachedBlocklist = data; cacheExpiry = now + CACHE_TTL_MS; }
  } catch (e) {}
  return cachedBlocklist;
}

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  return ((parseInt(p[0]) << 24) | (parseInt(p[1]) << 16) |
          (parseInt(p[2]) << 8) | parseInt(p[3])) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = bits ? (~0 << (32 - parseInt(bits))) >>> 0 : 0xFFFFFFFF;
  const a = ipv4ToInt(ip), b = ipv4ToInt(range);
  if (a === null || b === null) return false;
  return (a & mask) === (b & mask);
}

function expandIPv6(ip) {
  let parts = ip.split(':');
  const ei = parts.indexOf('');
  if (ei !== -1) {
    const head = parts.slice(0, ei);
    const tail = parts.slice(ei + 1).filter(p => p !== '');
    parts = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  }
  return parts.map(p => p.padStart(4, '0')).join(':');
}

function ipv6InCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr || '128');
  const n = Math.ceil(bits / 4);
  return expandIPv6(ip).replace(/:/g, '').substring(0, n) ===
         expandIPv6(range).replace(/:/g, '').substring(0, n);
}

function checkIP(ip, bl, asn) {
  if (!bl || !ip) return null;
  const v6 = ip.includes(':');
  if (bl.ips) for (const r of bl.ips) if (r.ip === ip) return r.action || 'block';
  if (bl.cidrs) for (const r of bl.cidrs) {
    if (!r.cidr) continue;
    if (v6 && r.cidr.includes(':') && ipv6InCidr(ip, r.cidr)) return r.action || 'block';
    if (!v6 && !r.cidr.includes(':') && ipv4InCidr(ip, r.cidr)) return r.action || 'block';
  }
  if (asn && bl.asns) for (const r of bl.asns) if (r.asn === asn) return r.action || 'block';
  return null;
}

const UTM_PARAMS = ['utm_source','utm_medium','utm_campaign','utm_term',
  'utm_content','gclid','wbraid','gbraid','fbclid','msclkid'];

function hasUTM(url) {
  const p = url.searchParams;
  for (const k of UTM_PARAMS) if (p.has(k)) return true;
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/__botguard_health') {
      return new Response(JSON.stringify({ status: 'active', ts: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/')) return fetch(request);

    const bl = await getBlocklist(env);
    if (!bl || !bl.enabled) return fetch(request);
    if (bl.scan_mode === 'utm' && !hasUTM(url)) return fetch(request);

    const ip = request.headers.get('cf-connecting-ip');
    const cf = request.cf || {};
    const asn = cf.asn ? Number(cf.asn) : null;
    const action = checkIP(ip, bl, asn);

    if (action === 'block') {
      return new Response(
        '<!DOCTYPE html><html><head><title>Error</title></head><body><h1>520</h1><p>Web server is returning an unknown error</p></body></html>',
        { status: 520, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    return fetch(request);
  }
};
`.trim();
}

// ── Cloudflare API helpers ───────────────────────────────────────────

async function cfFetch(path, token, opts = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...opts,
    headers: { ...cfHeaders(token), ...opts.headers },
  });
  return res.json();
}

/**
 * Find the Cloudflare zone ID for a domain.
 */
async function getZoneId(domain, token) {
  const parts = domain.split('.');
  const root = parts.slice(-2).join('.');
  const data = await cfFetch(`/zones?name=${root}`, token);
  if (!data.success || !data.result?.length) {
    throw new Error(`Zone not found for ${domain}. Is it added to your Cloudflare account?`);
  }
  return data.result[0].id;
}

/**
 * Upload Worker script to Cloudflare.
 * Uses multipart form to attach the KV binding metadata alongside the script.
 */
async function uploadWorkerScript(accountId, workerName, script, kvNamespaceId, token) {
  // Metadata tells Cloudflare to bind the KV namespace as "BLOCKLIST"
  const metadata = {
    main_module: 'worker.js',
    bindings: [
      {
        type: 'kv_namespace',
        name: 'BLOCKLIST',
        namespace_id: kvNamespaceId,
      },
    ],
    compatibility_date: '2024-01-01',
  };

  // Cloudflare Workers API expects multipart form with metadata + script
  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');

  const res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    }
  );

  const data = await res.json();
  if (!data.success) {
    const msg = data.errors?.[0]?.message || 'Unknown error';
    throw new Error(`Worker upload failed: ${msg}`);
  }
  return data;
}

/**
 * Create or update a Worker route for a domain.
 */
async function setupRoute(zoneId, workerName, domain, token) {
  const pattern = `${domain}/*`;

  // Check existing routes
  const existing = await cfFetch(`/zones/${zoneId}/workers/routes`, token);
  if (existing.success && existing.result) {
    const found = existing.result.find(r => r.pattern === pattern);
    if (found) {
      // Update existing route
      await cfFetch(`/zones/${zoneId}/workers/routes/${found.id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ pattern, script: workerName }),
      });
      return found.id;
    }
  }

  // Create new route
  const data = await cfFetch(`/zones/${zoneId}/workers/routes`, token, {
    method: 'POST',
    body: JSON.stringify({ pattern, script: workerName }),
  });

  if (!data.success) {
    throw new Error(`Route creation failed: ${data.errors?.[0]?.message || 'Unknown'}`);
  }
  return data.result.id;
}

/**
 * Delete a Worker script.
 */
async function deleteWorker(accountId, workerName, token) {
  const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.ok;
}

/**
 * Delete a Worker route.
 */
async function deleteRoute(zoneId, routeId, token) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/workers/routes/${routeId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.ok;
}

/**
 * Check if a Worker exists in Cloudflare.
 */
async function workerExists(accountId, workerName, token) {
  const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.ok;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Deploy the BotGuard Worker to Cloudflare.
 * Creates the script with KV binding and sets up the domain route.
 *
 * @param {string} domain — e.g. "cookingshow.space"
 * @returns {object} — { success, workerName, routeId, zoneId }
 */
async function deployWorker(domain) {
  const { accountId, apiToken, kvNamespaceId } = getConfig();
  if (!accountId || !apiToken || !kvNamespaceId) {
    throw new Error('Missing CF_ACCOUNT_ID, CF_API_TOKEN, or CF_KV_NAMESPACE_ID');
  }

  const workerName = `botguard-${domain.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 50)}`;

  // 1. Get zone ID
  const zoneId = await getZoneId(domain, apiToken);
  logger.info('cf_deploy_zone', { domain, zoneId });

  // 2. Generate and upload Worker script
  const script = generateWorkerScript();
  await uploadWorkerScript(accountId, workerName, script, kvNamespaceId, apiToken);
  logger.info('cf_deploy_script', { workerName });

  // 3. Set up route
  const routeId = await setupRoute(zoneId, workerName, domain, apiToken);
  logger.info('cf_deploy_route', { pattern: `${domain}/*`, routeId });

  return { success: true, workerName, routeId, zoneId };
}

/**
 * Undeploy — remove the Worker route and script from Cloudflare.
 */
async function undeployWorker(domain, workerName, zoneId, routeId) {
  const { accountId, apiToken } = getConfig();
  if (!accountId || !apiToken) throw new Error('Missing Cloudflare credentials');

  // Delete route first (so traffic stops going to the Worker)
  if (routeId && zoneId) {
    try { await deleteRoute(zoneId, routeId, apiToken); } catch (e) {
      logger.warn('cf_undeploy_route_err', { err: e.message });
    }
  }

  // Delete Worker script
  if (workerName) {
    await deleteWorker(accountId, workerName, apiToken);
  }

  logger.info('cf_undeploy_done', { domain, workerName });
  return { success: true };
}

/**
 * Check if the Worker is actually deployed in Cloudflare.
 */
async function verifyDeployment(workerName) {
  const { accountId, apiToken } = getConfig();
  if (!accountId || !apiToken || !workerName) return { deployed: false };
  const exists = await workerExists(accountId, workerName, apiToken);
  return { deployed: exists, workerName };
}

module.exports = {
  deployWorker,
  undeployWorker,
  verifyDeployment,
  generateWorkerScript,
};
