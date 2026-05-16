/**
 * BotGuard Edge Firewall — Cloudflare Worker (standalone reference)
 *
 * This file is auto-deployed by BotGuard via the workerDeploy service.
 * You should NOT need to paste this manually — use the "Deploy Worker"
 * button in /admin/cloudflare instead.
 *
 * KV structure (4 separate keys):
 *   "config" — { enabled, scan_mode, version }
 *   "cidrs"  — [ { cidr, action, label }, ... ]
 *   "ips"    — [ { ip, action, label }, ... ]
 *   "asns"   — [ { asn, action, label }, ... ]
 *
 * Bind KV namespace as "BLOCKLIST".
 */

let cached = { config: null, cidrs: null, ips: null, asns: null };
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getBlocklist(env) {
  const now = Date.now();
  if (cached.config && now < cacheExpiry) return cached;
  try {
    const [config, cidrs, ips, asns] = await Promise.all([
      env.BLOCKLIST.get('config', { type: 'json' }),
      env.BLOCKLIST.get('cidrs', { type: 'json' }),
      env.BLOCKLIST.get('ips', { type: 'json' }),
      env.BLOCKLIST.get('asns', { type: 'json' }),
    ]);
    if (config) {
      cached = { config, cidrs: cidrs || [], ips: ips || [], asns: asns || [] };
      cacheExpiry = now + CACHE_TTL_MS;
    }
  } catch (e) {}
  return cached;
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

    if (url.pathname === '/__botguard_health') {
      return new Response(JSON.stringify({ status: 'active', ts: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/')) return fetch(request);

    const bl = await getBlocklist(env);
    if (!bl.config || !bl.config.enabled) return fetch(request);
    if (bl.config.scan_mode === 'utm' && !hasUTM(url)) return fetch(request);

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
  },
};
