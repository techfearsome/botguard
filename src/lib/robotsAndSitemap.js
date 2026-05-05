/**
 * robots.txt and sitemap.xml generation.
 *
 * Why dynamic instead of static files:
 *   - Campaigns with custom root_paths (e.g. /promo) need to be Disallow-ed
 *     individually. A static file can't track those.
 *   - Sitemap should advertise only the public site pages (homepage, privacy,
 *     terms, /p/:slug) and never campaigns - those are paid-traffic only.
 *   - The Sitemap: directive in robots.txt should include the current host.
 *
 * Crawl policy (production):
 *   Allow:  /, /privacy, /terms, /p/*, /static/*  (legal & public site)
 *   Block:  /go/*, /admin/*, /cb/*, /lv/*, /px/*, /healthz, every custom
 *           root_path, plus all reserved-but-unused paths
 *
 * For a staging deployment (BG_NO_INDEX=1 in env), we emit a global
 * Disallow: / so the staging instance never gets indexed.
 *
 * Crawl policy for AI scrapers:
 *   Defaults to allowing them. Workspaces can opt out by setting
 *   ws.settings.block_ai_crawlers=true (added in this change). When set,
 *   GPTBot/ClaudeBot/Google-Extended/anthropic-ai/PerplexityBot/CCBot etc.
 *   get a Disallow: /
 */

const { Campaign } = require('../models');

// Internal mounts that should never be indexed.
const INTERNAL_PATHS = [
  '/admin',
  '/cb',
  '/lv',
  '/px',
  '/go',
  '/healthz',
];

// AI/training crawlers we offer opt-out for. List drawn from the major
// well-known robot UAs that respect robots.txt. There are dozens more that
// don't respect it - those need network-level blocking, not robots policy.
const AI_CRAWLERS = [
  'GPTBot',          // OpenAI
  'ChatGPT-User',    // OpenAI (user-triggered fetches)
  'OAI-SearchBot',   // OpenAI search
  'ClaudeBot',       // Anthropic
  'anthropic-ai',    // Anthropic (legacy)
  'Claude-Web',      // Anthropic
  'cohere-ai',       // Cohere
  'Google-Extended', // Google AI training opt-out
  'PerplexityBot',   // Perplexity
  'CCBot',           // Common Crawl
  'FacebookBot',     // Meta
  'meta-externalagent', // Meta AI training
  'Bytespider',      // ByteDance / TikTok
  'Amazonbot',       // Amazon
  'Applebot-Extended', // Apple AI training
  'Diffbot',         // Diffbot
  'omgili',          // Omgili / Webz
  'YouBot',          // You.com
];

/**
 * Build the robots.txt content as a plain string.
 *
 * Output shape mirrors the canonical WordPress robots.txt that crawlers see
 * on millions of sites. This is intentional: the BotGuard origin shouldn't
 * be trivially fingerprinted from the robots.txt response. We don't fake
 * anything (the /wp-admin/ rules are true - that path doesn't exist here so
 * disallowing it is a true statement) but the body shape matches what WP
 * outputs by default.
 *
 * Key WP-conformance notes:
 *   - No leading comments. WP doesn't include any.
 *   - Single User-agent: * block.
 *   - /wp-admin/ Disallow + admin-ajax.php Allow appear FIRST. This is the
 *     two-line opener that every default WP install emits.
 *   - Real internal mounts (/admin/, /go/, etc.) and custom campaign root
 *     paths follow.
 *   - Allow: /static/ for assets (Google needs CSS/JS for ranking).
 *   - Single blank line, then Sitemap directive at the bottom.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {string} opts.protocol
 * @param {Array<string>} opts.disallowedRootPaths
 * @param {boolean} opts.noIndex
 * @param {boolean} opts.blockAi
 * @returns {string}
 */
function buildRobotsTxt(opts) {
  const {
    host,
    protocol = 'https',
    disallowedRootPaths = [],
    indexableCampaigns = [],
    noIndex = false,
    blockAi = false,
  } = opts;

  const lines = [];

  if (noIndex) {
    // Staging / dev: block everyone everywhere. No comments, no sitemap.
    lines.push('User-agent: *');
    lines.push('Disallow: /');
    return lines.join('\n') + '\n';
  }

  // Standard policy. WordPress-shaped opener.
  lines.push('User-agent: *');
  lines.push('Disallow: /wp-admin/');
  lines.push('Allow: /wp-admin/admin-ajax.php');

  // Real internal mounts (admin, cb, lv, px, healthz, plus the blanket /go/).
  // Indexable campaigns at /go/<slug> get a per-slug Allow line emitted
  // BEFORE the blanket Disallow, so crawlers honoring the longest-match
  // (Google, Bing) treat the Allow as the override. Older spec-compliant
  // crawlers do "first match wins" which also works with this ordering.
  for (const c of indexableCampaigns) {
    if (c && c.slug) {
      lines.push(`Allow: /go/${c.slug}`);
    }
  }
  for (const p of INTERNAL_PATHS) {
    lines.push(`Disallow: ${p}/`);
  }

  // Custom campaign root paths that opted OUT of indexing. Indexable ones
  // simply get no Disallow line - their root_path falls through to the
  // catch-all crawl-allow.
  for (const rp of disallowedRootPaths) {
    if (!rp || typeof rp !== 'string') continue;
    const slug = rp.trim().toLowerCase();
    if (!slug) continue;
    lines.push(`Disallow: /${slug}`);
  }

  // Allow CSS/JS so Google can render pages for ranking.
  lines.push('Allow: /static/');

  if (blockAi) {
    for (const ua of AI_CRAWLERS) {
      lines.push('');
      lines.push(`User-agent: ${ua}`);
      lines.push('Disallow: /');
    }
  }

  // Single blank line + Sitemap directive at the bottom (WP convention).
  lines.push('');
  lines.push(`Sitemap: ${protocol}://${host}/sitemap.xml`);

  return lines.join('\n') + '\n';
}

/**
 * Build sitemap.xml. Lists the public site pages only - homepage, privacy,
 * terms, and any custom /p/<slug> pages the workspace has configured. Never
 * lists campaign URLs (those are paid-only) or internal routes.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {string} opts.protocol
 * @param {Array<{slug:string, updated_at?:Date}>} opts.publicPages - includes
 *   the synthetic 'home', 'privacy', 'terms' entries plus any /p/<slug>.
 * @returns {string}
 */
function buildSitemapXml(opts) {
  const { host, protocol = 'https', publicPages = [], indexableCampaigns = [] } = opts;
  const base = `${protocol}://${host}`;

  const urls = [];
  for (const page of publicPages) {
    if (!page || !page.slug) continue;
    // Respect per-page noindex flag - if the admin marked a page as
    // noindex in its meta settings, exclude it from the sitemap. (The
    // page itself can still be served via /privacy etc.; we just don't
    // advertise it to crawlers.)
    if (page.meta && page.meta.noindex) continue;
    let url;
    if (page.slug === 'home') {
      url = `${base}/`;
    } else if (page.slug === 'privacy') {
      url = `${base}/privacy`;
    } else if (page.slug === 'terms') {
      url = `${base}/terms`;
    } else {
      url = `${base}/p/${encodeURIComponent(page.slug)}`;
    }
    const lastmod = page.updated_at ? new Date(page.updated_at).toISOString().slice(0, 10) : null;
    urls.push({ url, lastmod, priority: '0.7' });
  }

  // Include indexable campaign URLs. We prefer the custom root_path form
  // (cleaner URL, better for SEO) when available, falling back to /go/<slug>.
  // Including BOTH would split rank between two URLs for the same content,
  // which is bad SEO - so we emit only one URL per campaign.
  for (const c of indexableCampaigns) {
    if (!c || !c.slug) continue;
    const url = c.root_path
      ? `${base}/${encodeURIComponent(c.root_path)}`
      : `${base}/go/${encodeURIComponent(c.slug)}`;
    const lastmod = c.updated_at ? new Date(c.updated_at).toISOString().slice(0, 10) : null;
    urls.push({ url, lastmod, priority: '0.8' });
  }

  const xml = ['<?xml version="1.0" encoding="UTF-8"?>'];
  xml.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap-0.9">');
  for (const { url, lastmod, priority } of urls) {
    xml.push('  <url>');
    xml.push(`    <loc>${escapeXml(url)}</loc>`);
    if (lastmod) xml.push(`    <lastmod>${lastmod}</lastmod>`);
    if (priority) xml.push(`    <priority>${priority}</priority>`);
    xml.push('  </url>');
  }
  xml.push('</urlset>');
  return xml.join('\n') + '\n';
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/**
 * Fetch the list of custom root_paths for campaigns that should be
 * Disallow-ed in robots.txt. EXCLUDES campaigns marked indexable=true, since
 * those are explicitly opted-in to crawler access.
 */
async function listDisallowedRootPaths(workspaceId) {
  const filter = {
    root_path: { $type: 'string', $ne: '' },
    indexable: { $ne: true },
    status: { $ne: 'archived' },
  };
  if (workspaceId) filter.workspace_id = workspaceId;
  const docs = await Campaign.find(filter).select('root_path').lean();
  return docs.map((d) => d.root_path).filter(Boolean);
}

/**
 * Fetch the list of indexable campaigns. Used by:
 *   - robots.txt generator (to emit Allow: /go/<slug> overrides for the
 *     blanket Disallow: /go/ rule)
 *   - sitemap.xml generator (to include their URLs in the sitemap)
 *
 * Returns objects with both slug (for /go/<slug>) and root_path (for
 * /<root_path>) so callers can build whichever URL form they need.
 */
async function listIndexableCampaigns(workspaceId) {
  const filter = {
    indexable: true,
    status: 'active',                // archived/paused not eligible for indexing
  };
  if (workspaceId) filter.workspace_id = workspaceId;
  return Campaign.find(filter).select('slug root_path updated_at').lean();
}

module.exports = {
  buildRobotsTxt,
  buildSitemapXml,
  listDisallowedRootPaths,
  listIndexableCampaigns,
  AI_CRAWLERS,        // exported for tests
  INTERNAL_PATHS,     // exported for tests
};
