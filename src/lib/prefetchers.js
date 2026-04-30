/**
 * Email prefetchers, link scanners, and security gateways.
 *
 * These services WILL hit your /go URLs before the human does. They look bot-like on every signal:
 *   - Datacenter ASNs (Microsoft, Apple, Google, Proofpoint, Mimecast)
 *   - Generic UAs or no-JS clients
 *   - Missing Accept-Language, weird header order
 *   - No mouse, no canvas, no real fingerprint
 *
 * If we score them like ad traffic, we'll get a "blocked" decision logged for every
 * Outlook user and every Apple Mail user with MPP enabled - which is most of them.
 *
 * Strategy: detect these via UA/IP/ASN. When matched, the click gets:
 *   - flagged as "prefetcher" (not "human", not "bot")
 *   - logged separately so it doesn't pollute conversion stats
 *   - decision: allow + flag, regardless of score
 *
 * The actual human click that follows will have its own session and score normally.
 */

// User-agent substrings that identify scanners/prefetchers
const SCANNER_UA_SUBSTRINGS = [
  // Microsoft / Outlook
  'bingpreview',
  'safelinks',
  'outlook',
  'msoffice',
  'office 16',
  // Apple Mail Privacy Protection
  // Apple's MPP uses generic UAs, mainly identified by IP ranges (see below)
  // Gmail
  'googleimageproxy',
  'gmailimageproxy',
  'feedfetcher-google',
  // Yahoo
  'yahoomailproxy',
  // Link scanners
  'mimecast',
  'proofpoint',
  'urldefense',
  'barracuda',
  'symantec',
  'trendmicro',
  'sophos',
  'forcepoint',
  'cisco-ironport',
  'fireeye',
  'avanan',
  'darktrace',
  'agari',
  // Generic security scanners
  'slack-imgproxy',
  'slackbot-linkexpanding',
  'twitterbot',          // not email but treats links similarly
  'linkedinbot',
  'whatsapp',            // unfurls links before user opens
  'telegrambot',
  'discordbot',
  'skypeuripreview',
];

// ASN ranges associated with known prefetchers / Apple MPP
// Apple MPP routes through their iCloud Private Relay infrastructure
const PREFETCHER_ASNS = new Set([
  // Apple
  714,        // APPLE-ENGINEERING
  6185,       // APPLE-AUSTIN
  // Microsoft (Outlook, SafeLinks, ATP)
  8075,       // MICROSOFT-CORP-MSN-AS-BLOCK
  // Mimecast
  41557,      // MIMECAST-AS
  43996,      // MIMECAST
  // Proofpoint
  22843,      // PROOFPOINT-ASN
  396982,     // PROOFPOINT-ASN
  // Barracuda
  16895,      // BARRACUDA-NETWORKS
  // Cloudflare email routing
  13335,      // CLOUDFLARENET (used by many email security products)
]);

/**
 * Determine if a request looks like an email prefetcher / link scanner.
 *
 * Returns: { is_prefetcher: bool, kind?: string, reason?: string }
 *
 * `kind` values:
 *   - 'safelinks'      Microsoft SafeLinks / ATP
 *   - 'apple_mpp'      Apple Mail Privacy Protection
 *   - 'gmail_proxy'    Gmail image / link proxy
 *   - 'security_gw'    Mimecast / Proofpoint / Barracuda / etc.
 *   - 'social_unfurl'  Slack / Discord / Twitter / WhatsApp link expansion
 *   - 'generic'        Matched by ASN but UA didn't tell us which one
 */
function detectPrefetcher({ userAgent = '', asn = null } = {}) {
  const ua = (userAgent || '').toLowerCase();

  // UA-based detection (most specific)
  for (const needle of SCANNER_UA_SUBSTRINGS) {
    if (ua.includes(needle)) {
      return { is_prefetcher: true, kind: classifyKind(needle), reason: `ua_match:${needle}` };
    }
  }

  // ASN-based detection (Apple MPP especially - their UAs are too generic to filter)
  if (asn && PREFETCHER_ASNS.has(Number(asn))) {
    // Apple MPP specifically: GET requests to your URL from Apple ASNs without
    // typical browser fingerprint indicators. We don't have fingerprint here yet,
    // but the ASN match alone is a strong enough signal.
    if ([714, 6185].includes(Number(asn))) {
      return { is_prefetcher: true, kind: 'apple_mpp', reason: `asn_match:apple` };
    }
    return { is_prefetcher: true, kind: 'generic', reason: `asn_match:${asn}` };
  }

  return { is_prefetcher: false };
}

function classifyKind(needle) {
  if (needle.includes('safelinks') || needle.includes('outlook') || needle.includes('msoffice') || needle.includes('bingpreview')) return 'safelinks';
  if (needle.includes('gmail') || needle.includes('feedfetcher')) return 'gmail_proxy';
  if (['mimecast','proofpoint','urldefense','barracuda','symantec','trendmicro','sophos','forcepoint','cisco-ironport','fireeye','avanan','darktrace','agari'].some(n => needle.includes(n))) return 'security_gw';
  if (['slack','discord','telegram','twitter','linkedin','whatsapp','skype'].some(n => needle.includes(n))) return 'social_unfurl';
  return 'generic';
}

module.exports = { detectPrefetcher, PREFETCHER_ASNS, SCANNER_UA_SUBSTRINGS };
