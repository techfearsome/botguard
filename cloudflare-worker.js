/**
 * BotGuard Edge Firewall — Cloudflare Worker
 *
 * Reads the blocklist from KV (pushed by BotGuard via API).
 * Two scan modes controlled from the BotGuard dashboard:
 *
 *   "all"  — checks EVERY request. Full edge firewall.
 *   "utm"  — only checks requests with utm_source/gclid/wbraid/fbclid/msclkid
 *            in the URL. This means only ad clicks get checked, organic and
 *            direct traffic passes through untouched.
 *
 * The mode and enabled state are stored inside the KV blocklist JSON,
 * so changing them in BotGuard + syncing = instant update, no Worker redeploy.
 *
 * Setup:
 *   1. Create KV namespace "BOTGUARD_BLOCKLIST" in Cloudflare dashboard
 *   2. Bind it to this Worker as "BLOCKLIST"
 *   3. Deploy the Worker on your domain's route
 *   4. In BotGuard, set CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
 *   5. Push rules from /admin/cloudflare
 */

// In-memory cache
let cachedBlocklist = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getBlocklist(env) {
  const now = Date.now();
  if (cachedBlocklist && now < cacheExpiry) return cachedBlocklist;

  try {
    const data = await env.BLOCKLIST.get('blocklist', { type: 'json' });
    if (data) {
      cachedBlocklist = data;
      cacheExpiry = now + CACHE_TTL_MS;
    }
  } catch (e) {
    // KV read failed — keep stale cache
  }
  return cachedBlocklist;
}

// ── IP matching ──────────────────────────────────────────────────────

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  return ((parseInt(p[0]) << 24) | (parseInt(p[1]) << 16) |
          (parseInt(p[2]) << 8) | parseInt(p[3])) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = bits ? (~0 << (32 - parseInt(bits))) >>> 0 : 0xFFFFFFFF;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  return (ipInt & mask) === (rangeInt & mask);
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
  const hexChars = Math.ceil(bits / 4);
  const ipHex = expandIPv6(ip).replace(/:/g, '').substring(0, hexChars);
  const rangeHex = expandIPv6(range).replace(/:/g, '').substring(0, hexChars);
  return ipHex === rangeHex;
}

function checkIP(ip, blocklist) {
  if (!blocklist || !ip) return null;
  const isV6 = ip.includes(':');

  if (blocklist.ips) {
    for (const r of blocklist.ips) {
      if (r.ip === ip) return r.action || 'block';
    }
  }

  if (blocklist.cidrs) {
    for (const r of blocklist.cidrs) {
      if (!r.cidr) continue;
      if (isV6 && r.cidr.includes(':')) {
        if (ipv6InCidr(ip, r.cidr)) return r.action || 'block';
      } else if (!isV6 && !r.cidr.includes(':')) {
        if (ipv4InCidr(ip, r.cidr)) return r.action || 'block';
      }
    }
  }

  return null;
}

// ── UTM detection ────────────────────────────────────────────────────

const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
                    'utm_content', 'gclid', 'wbraid', 'gbraid', 'fbclid', 'msclkid'];

function hasUTMParams(url) {
  const params = url.searchParams;
  for (const p of UTM_PARAMS) {
    if (params.has(p)) return true;
  }
  return false;
}

// ── Worker entry point ───────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never block admin panel requests
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/')) {
      return fetch(request);
    }

    const blocklist = await getBlocklist(env);

    // If no blocklist loaded or disabled, pass through
    if (!blocklist || !blocklist.enabled) {
      return fetch(request);
    }

    // Scan mode check
    // "utm" = only check requests with ad click parameters
    // "all" = check every request
    if (blocklist.scan_mode === 'utm' && !hasUTMParams(url)) {
      return fetch(request);
    }

    // Check the IP
    const ip = request.headers.get('cf-connecting-ip');
    const action = checkIP(ip, blocklist);

    if (action === 'block') {
      return new Response(
        '<!DOCTYPE html><html><head><title>Error</title></head><body>' +
        '<h1>520</h1><p>Web server is returning an unknown error</p>' +
        '</body></html>',
        {
          status: 520,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    if (action === 'challenge') {
      // Future: redirect to a CAPTCHA/challenge page
      return fetch(request);
    }

    // No match — pass through
    return fetch(request);
  },
};
