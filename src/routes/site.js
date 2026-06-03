const express = require('express');
const router = express.Router();

const { SitePage, Workspace } = require('../models');
const { DEFAULT_SLUG } = require('../lib/bootstrap');
const logger = require('../lib/logger');
const { setPingbackHeader, injectWpMeta } = require('../lib/wpFingerprint');

/**
 * Public site pages - served at top-level paths so the root domain isn't a dead end.
 *
 * Routes:
 *   GET /         → SitePage with slug='home'
 *   GET /privacy  → slug='privacy'
 *   GET /terms    → slug='terms'
 *   GET /p/:slug  → arbitrary site pages
 *
 * Multi-tenant ready: defaults to the DEFAULT_WORKSPACE_SLUG. When SaaS is turned on,
 * we'll resolve workspace from hostname instead.
 */

async function resolveWorkspace() {
  return Workspace.findOne({ slug: DEFAULT_SLUG });
}

async function renderSitePage(req, res, slug) {
  try {
    const ws = await resolveWorkspace();
    if (!ws) return res.status(404).type('html').send(notFoundHtml(slug));

    const page = await SitePage.findOne({ workspace_id: ws._id, slug, enabled: true }).lean();
    if (!page) {
      // No page configured for this slug. If we're already trying to render the 404 itself,
      // fall back to the hardcoded HTML to avoid an infinite loop. Otherwise delegate
      // to render404 so a configured 404 page is shown.
      if (slug === '404') {
        return res.status(404).type('html').send(notFoundHtml(slug));
      }
      return render404(req, res);
    }

    const status = slug === '404' ? 404 : 200;
    res.status(status);
    res.set('Cache-Control', 'public, max-age=300');     // 5min - static pages can cache
    if (page.meta?.noindex) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    // WordPress fingerprint surface: emit X-Pingback header + inject WP meta
    // tags so Wappalyzer-style fingerprinters classify the site as WP.
    // Doesn't affect rendering or content - just adds 3 lines to <head> and
    // one response header. See src/lib/wpFingerprint.js for the strategy.
    setPingbackHeader(req, res);
    res.type('html').send(injectWpMeta(renderPageWrapper(page)));
  } catch (err) {
    logger.error('site_page_error', { slug, err: err.message });
    res.status(500).send('Internal error');
  }
}

/**
 * Public 404 renderer. Tries to serve the SitePage with slug='404' if configured;
 * otherwise falls back to the hardcoded "Page not found" HTML.
 *
 * Used both by the site router (for unknown /p/ slugs) and the global 404 handler in server.js
 * (for any unmatched route on the domain).
 */
async function render404(req, res) {
  try {
    const ws = await resolveWorkspace();
    if (ws) {
      const page = await SitePage.findOne({ workspace_id: ws._id, slug: '404', enabled: true }).lean();
      if (page) {
        res.status(404);
        res.set('Cache-Control', 'no-store');     // 404 from unknown URL - don't cache
        if (page.meta?.noindex !== false) {
          // 404 pages should always be noindex by default
          res.set('X-Robots-Tag', 'noindex, nofollow');
        }
        setPingbackHeader(req, res);
        return res.type('html').send(injectWpMeta(renderPageWrapper(page)));
      }
    }
  } catch (err) {
    logger.error('render_404_error', { err: err.message });
  }
  setPingbackHeader(req, res);
  res.status(404).type('html').send(injectWpMeta(notFoundHtml('404')));
}

function renderPageWrapper(page) {
  // If the stored HTML is already a complete document, serve it as-is.
  // Otherwise wrap it in a minimal default shell.
  const html = page.html || '';
  const looksComplete = /<!DOCTYPE\s+html>/i.test(html) || /<html[\s>]/i.test(html);
  if (looksComplete) return html;

  const meta = page.meta || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(page.title || page.slug)}</title>
  ${meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}">` : ''}
  ${meta.og_image ? `<meta property="og:image" content="${escapeHtml(meta.og_image)}">` : ''}
  ${meta.noindex ? `<meta name="robots" content="noindex, nofollow">` : ''}
</head>
<body>
${html}
</body>
</html>`;
}

function notFoundHtml(slug) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Not found</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#333}h1{font-size:22px}.muted{color:#7a8294}</style>
</head><body>
<h1>Page not found</h1>
<p class="muted">The page <code>/${escapeHtml(slug === 'home' ? '' : slug)}</code> isn't configured.</p>
</body></html>`;
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

router.get('/', (req, res) => renderSitePage(req, res, 'home'));
router.get('/privacy', (req, res) => renderSitePage(req, res, 'privacy'));
router.get('/terms', (req, res) => renderSitePage(req, res, 'terms'));
router.get('/p/:slug', (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).send('Invalid slug');
  return renderSitePage(req, res, slug);
});

// --- robots.txt ---
//
// Generated dynamically because the policy depends on:
//   1. Custom campaign root_paths (each must be Disallow-ed)
//   2. The request host (sitemap reference includes it)
//   3. Per-environment opt-out (BG_NO_INDEX=1 disallows everything)
//   4. Per-workspace AI-crawler opt-out (settings.block_ai_crawlers)
//
// Cached in-memory; invalidated when campaigns are saved/deleted.
const { buildRobotsTxt, buildSitemapXml, buildWpSitemapIndex, buildWpSitemapPages, buildWpSitemapPosts, listDisallowedRootPaths, listIndexableCampaigns, listAllCampaignPaths } = require('../lib/robotsAndSitemap');

let robotsCache = { ts: 0, body: '', forHost: '' };
let sitemapCache = { ts: 0, body: '', forHost: '' };
const ROBOTS_CACHE_MS = 5 * 60 * 1000;
const SITEMAP_CACHE_MS = 5 * 60 * 1000;

router.get('/robots.txt', async (req, res) => {
  try {
    const host = req.hostname || req.get('host') || 'localhost';
    const protocol = req.protocol || 'https';

    // Cheap cache - only valid for the same host. If the same instance serves
    // multiple hosts (multi-tenant future) we'll rekey by host.
    const now = Date.now();
    let body = robotsCache.body;
    if (!body || robotsCache.forHost !== host || (now - robotsCache.ts) >= ROBOTS_CACHE_MS) {
      const ws = await resolveWorkspace();
      const blockAi = !!(ws && ws.settings && ws.settings.block_ai_crawlers);
      const [disallowedRootPaths, indexableCampaigns, allCampaignPaths] = ws ? await Promise.all([
        listDisallowedRootPaths(ws._id),
        listIndexableCampaigns(ws._id),
        listAllCampaignPaths(ws._id),
      ]) : [[], [], []];
      body = buildRobotsTxt({
        host,
        protocol,
        disallowedRootPaths,
        indexableCampaigns,
        allCampaignPaths,
        noIndex: process.env.BG_NO_INDEX === '1',
        blockAi,
      });
      robotsCache = { ts: now, body, forHost: host };
    }

    // Mimic stock WordPress response headers: text/plain, no Cache-Control,
    // no X-Robots-Tag, no X-Powered-By. The body shape and these headers
    // together make the response indistinguishable from a default WP install.
    res.type('text/plain').send(body);
  } catch (err) {
    logger.error('robots_txt_error', { err: err.message });
    res.type('text/plain').send('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n');
  }
});

router.get('/sitemap.xml', async (req, res) => {
  try {
    const host = req.hostname || req.get('host') || 'localhost';
    const protocol = req.protocol || 'https';

    const now = Date.now();
    let body = sitemapCache.body;
    if (!body || sitemapCache.forHost !== host || (now - sitemapCache.ts) >= SITEMAP_CACHE_MS) {
      const ws = await resolveWorkspace();
      const [sitePages, indexableCampaigns] = ws ? await Promise.all([
        SitePage.find({ workspace_id: ws._id, enabled: true }).select('slug updated_at meta').lean(),
        listIndexableCampaigns(ws._id),
      ]) : [[], []];
      body = buildSitemapXml({ host, protocol, publicPages: sitePages, indexableCampaigns });
      sitemapCache = { ts: now, body, forHost: host };
    }

    res.type('application/xml').send(body);
  } catch (err) {
    logger.error('sitemap_xml_error', { err: err.message });
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap-0.9"></urlset>\n');
  }
});

// --- WordPress 5.5+ core sitemaps ---
// These replicate the exact URL patterns that WordPress generates.
// `/wp-sitemap.xml` is the index, sub-sitemaps break down by content type.

router.get('/wp-sitemap.xml', async (req, res) => {
  try {
    const host = req.hostname || req.get('host') || 'localhost';
    const protocol = req.protocol || 'https';
    const body = buildWpSitemapIndex({ host, protocol });
    res.type('application/xml').send(body);
  } catch (err) {
    logger.error('wp_sitemap_index_error', { err: err.message });
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>\n');
  }
});

router.get('/wp-sitemap-posts-page-1.xml', async (req, res) => {
  try {
    const host = req.hostname || req.get('host') || 'localhost';
    const protocol = req.protocol || 'https';
    const ws = await resolveWorkspace();
    const pages = ws ? await SitePage.find({ workspace_id: ws._id, enabled: true }).select('slug updated_at meta').lean() : [];
    const body = buildWpSitemapPages({ host, protocol, publicPages: pages });
    res.type('application/xml').send(body);
  } catch (err) {
    logger.error('wp_sitemap_pages_error', { err: err.message });
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n');
  }
});

router.get('/wp-sitemap-posts-post-1.xml', async (req, res) => {
  try {
    const host = req.hostname || req.get('host') || 'localhost';
    const protocol = req.protocol || 'https';
    const ws = await resolveWorkspace();
    const campaigns = ws ? await listIndexableCampaigns(ws._id) : [];
    const body = buildWpSitemapPosts({ host, protocol, indexableCampaigns: campaigns });
    res.type('application/xml').send(body);
  } catch (err) {
    logger.error('wp_sitemap_posts_error', { err: err.message });
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n');
  }
});

// XSL stylesheets — WP serves these for human-readable sitemap display.
// Returning a minimal XSL avoids 404s when crawlers follow the processing
// instruction in the XML.
const wpSitemapXsl = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9">
<xsl:output method="html" encoding="UTF-8" indent="yes"/>
<xsl:template match="/">
<html><head><title>XML Sitemap</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:40px;color:#1d2327}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #c3c4c7}th{background:#f0f0f1}a{color:#2271b1}</style>
</head><body>
<h1>XML Sitemap</h1>
<p>Generated by WordPress</p>
<table>
<tr><th>URL</th><th>Last Modified</th></tr>
<xsl:for-each select="sitemap:urlset/sitemap:url">
<tr><td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td><td><xsl:value-of select="sitemap:lastmod"/></td></tr>
</xsl:for-each>
</table>
</body></html>
</xsl:template>
</xsl:stylesheet>`;

router.get('/wp-sitemap.xsl', (req, res) => {
  res.type('application/xml').send(wpSitemapXsl);
});

router.get('/wp-sitemap-index.xsl', (req, res) => {
  // Reuse the same XSL — close enough for fingerprint purposes
  res.type('application/xml').send(wpSitemapXsl);
});

// Hooks for tests + admin route handlers: clear caches on demand.
function clearRobotsCache() { robotsCache = { ts: 0, body: '', forHost: '' }; }
function clearSitemapCache() { sitemapCache = { ts: 0, body: '', forHost: '' }; }
function clearAllCaches() { clearRobotsCache(); clearSitemapCache(); }

// Router is the default export. render404 is exposed as a property on the router
// so server.js can call it from the app-wide 404 fallback handler.
module.exports = Object.assign(router, { render404, clearRobotsCache, clearSitemapCache, clearAllCaches });
