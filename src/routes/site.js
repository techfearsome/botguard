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
    if (!ws) return next();    // no workspace yet - let other routes handle

    const page = await SitePage.findOne({ workspace_id: ws._id, slug, enabled: true }).lean();
    if (!page) {
      // No page configured - return a friendly 404 so the user knows they hit a real route
      // (better than redirecting to admin login which would be confusing)
      res.status(404).type('html').send(notFoundHtml(slug));
      return;
    }

    res.set('Cache-Control', 'public, max-age=300');     // 5min - static pages can cache
    if (page.meta?.noindex) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    res.status(200).type('html').send(renderPageWrapper(page));
  } catch (err) {
    logger.error('site_page_error', { slug, err: err.message });
    res.status(500).send('Internal error');
  }
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

module.exports = router;
