const express = require('express');
const router = express.Router();

const { SitePage, Workspace } = require('../models');
const { DEFAULT_SLUG } = require('../lib/bootstrap');
const logger = require('../lib/logger');

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
    res.type('html').send(renderPageWrapper(page));
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
        return res.type('html').send(renderPageWrapper(page));
      }
    }
  } catch (err) {
    logger.error('render_404_error', { err: err.message });
  }
  res.status(404).type('html').send(notFoundHtml('404'));
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

// Router is the default export. render404 is exposed as a property on the router
// so server.js can call it from the app-wide 404 fallback handler.
module.exports = Object.assign(router, { render404 });
