require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');

const { ensureDefaultWorkspace } = require('./lib/bootstrap');
const logger = require('./lib/logger');

const goRoutes = require('./routes/go');
const pixelRoutes = require('./routes/pixel');
const postbackRoutes = require('./routes/postback');
const liveRoutes = require('./routes/live');
const adminRoutes = require('./routes/admin');
const siteRoutes = require('./routes/site');

const app = express();

// Trust proxy for correct IP detection behind Cloudflare/nginx.
// Two modes:
//   - TRUST_PROXY=cloudflare (recommended): only trust Cloudflare's documented IP ranges +
//     the loopback (for nginx/Traefik between Cloudflare and us). Prevents header spoofing
//     because untrusted upstreams can't set X-Forwarded-For / CF-Connecting-IP themselves.
//   - TRUST_PROXY=<n> (number): trust the n-th hop. Use 1 if there's only one reverse proxy.
//   - TRUST_PROXY=true: trust everything (NOT recommended outside dev).
const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv === 'cloudflare') {
  // Cloudflare's published IPv4+IPv6 ranges from https://www.cloudflare.com/ips/
  // (last reviewed Apr 2026 - update if Cloudflare adds new ranges).
  app.set('trust proxy', [
    'loopback', 'linklocal', 'uniquelocal',
    // IPv4
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    // IPv6
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
  ]);
  logger.info('trust_proxy_cloudflare_enabled');
} else if (trustProxyEnv === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyEnv) {
  app.set('trust proxy', Number(trustProxyEnv) || 1);
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers — relaxed for landing pages since we render arbitrary HTML
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());
app.use(cookieParser());

// Body parsing. We parse JSON for the standard content-type AND for text/plain,
// because navigator.sendBeacon() in some browsers sends application/json blobs
// with the content-type set to text/plain by the browser's blob handling.
// This lets the auto-conv beacon work everywhere without needing a fetch fallback.
app.use(express.json({
  limit: '1mb',
  type: ['application/json', 'text/plain'],
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Static assets - cached aggressively at the Cloudflare edge.
// 1 day max-age + immutable for files that effectively never change (CSS, JS, images).
// If you change the content, bust by either changing the path or purging Cloudflare.
app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1d',
  immutable: false,           // keep false unless you fingerprint filenames
  setHeaders: (res, filePath) => {
    // Allow Cloudflare to cache; allow browser to cache but revalidate after a day.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    // Hint to Cloudflare it's safe to cache regardless of cookies on the request.
    // (Cloudflare normally bypasses cache when request has cookies; CDN-Cache-Control overrides that.)
    res.setHeader('CDN-Cache-Control', 'public, max-age=86400');
  },
}));

// --- Hot path routes (the actual landing page traffic) ---
app.use('/go', goRoutes);
app.use('/px', pixelRoutes);
app.use('/cb', postbackRoutes);
app.use('/lv', liveRoutes);

// --- Admin panel (scoped per workspace, multi-tenant ready) ---
app.use('/admin', adminRoutes);

// --- Public site pages (homepage, privacy, terms, /p/:slug) ---
// Mounted AFTER /admin so /admin doesn't get caught by the / handler.
// When no SitePage is configured, these fall through to a real 404 (not the admin login).
app.use('/', siteRoutes);

// Health check
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 404 handler. For browser requests (Accept: text/html) we render the configured
// SitePage with slug='404'. For API/JSON requests we keep returning JSON.
app.use((req, res) => {
  // If the client asked for HTML, give them the styled 404 page
  if (req.accepts('html')) {
    return siteRoutes.render404(req, res);
  }
  res.status(404).json({ error: 'not_found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('unhandled_error', { err: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal_error' });
});

async function start() {
  await mongoose.connect(process.env.MONGO_URI);
  logger.info('mongo_connected', { uri: process.env.MONGO_URI });

  await ensureDefaultWorkspace();

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    logger.info('server_started', { port, base_url: process.env.BASE_URL });
  });

  // Graceful shutdown - critical for rolling deploys behind Coolify/Docker.
  // When the orchestrator sends SIGTERM, we:
  //   1. Stop accepting new connections
  //   2. Let in-flight requests finish (up to 10s)
  //   3. Close Mongo connection cleanly
  //   4. Exit
  // Without this, active visitors mid-request would see connection resets
  // every time you redeploy.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });

    // Stop accepting new connections
    server.close((err) => {
      if (err) logger.error('server_close_error', { err: err.message });
      else logger.info('server_closed');
      // Close Mongo last so any in-flight click writes can complete
      mongoose.connection.close(false).then(() => {
        logger.info('mongo_closed');
        process.exit(0);
      }).catch((e) => {
        logger.error('mongo_close_error', { err: e.message });
        process.exit(1);
      });
    });

    // Hard timeout - if we can't close gracefully in 10s, force exit
    setTimeout(() => {
      logger.error('shutdown_timeout_forcing_exit');
      process.exit(1);
    }, 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('startup_failed', { err: err.message, stack: err.stack });
  process.exit(1);
});
