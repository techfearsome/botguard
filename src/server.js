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

// Make the localTime helper available in every template under `localTime`.
// Templates use it like: <%- localTime(c.ts) %> to emit a <time> element that
// the browser-side script (public/js/local-time.js) rewrites into the
// visitor's local timezone. Without this, server-side toLocaleString() would
// always render in the server's TZ (UTC on Coolify) regardless of admin location.
const { localTime } = require('./lib/localTime');
app.locals.localTime = localTime;

// Asset versioning. Every /static/... URL includes a ?v=<build-id> query
// string so Cloudflare and browser caches treat each deploy's files as new
// URLs. Without this, our 24h s-maxage on /static/* means changes to JS/CSS
// files only become visible 24h after deploy (or after manual Cloudflare
// purge), which is a brutal feedback loop.
//
// BUILD_ID is provided by env (Coolify can set it from the git commit SHA);
// otherwise we fall back to the server start time. Either way, every
// process restart -> new ?v= -> caches bust automatically.
const BUILD_ID = process.env.BUILD_ID || String(Date.now());
app.locals.assetUrl = (path) => {
  if (!path) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}v=${BUILD_ID}`;
};
app.locals.BUILD_ID = BUILD_ID;

// Security headers — relaxed for landing pages since we render arbitrary HTML
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(compression({
  filter: function (req, res) {
    if (req.path === '/admin/live/stream') return false;
    if (res.getHeader('Content-Type')?.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));
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

// --- Google Ads exclusion sync API ---
const gadsSyncRoutes = require('./routes/gadsSync');
app.use('/api', gadsSyncRoutes);

// Federated threat-intel export feed (partner-authenticated, read-only).
const syncRoutes = require('./routes/sync');
app.use('/sync', syncRoutes);

// --- Media uploads: serve images stored in Mongo at a WordPress-looking path.
// Public (images are embedded in pages), long immutable cache so Cloudflare
// serves from edge after the first origin fetch. Mounted before the root_path
// catch-all; multi-segment path so it never collides with a campaign slug.
app.get('/wp-content/uploads/:id/:filename', async (req, res) => {
  try {
    const { Upload } = require('./models');
    const storage = require('./lib/storage');
    const doc = await Upload.findById(req.params.id).lean();
    if (!doc) return res.status(404).end();
    const handled = await storage.serve(res, doc);
    if (!handled) return res.status(404).end();
    return;
  } catch (e) {
    return res.status(404).end();
  }
});

// --- Admin panel (scoped per workspace, multi-tenant ready) ---
app.use('/admin', adminRoutes);

// --- Public site pages (homepage, privacy, terms, /p/:slug) ---
// Mounted AFTER /admin so /admin doesn't get caught by the / handler.
// When no SitePage is configured, these fall through to a real 404 (not the admin login).
app.use('/', siteRoutes);

// Health check
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- WordPress fingerprint honeypot ---
// Serves plausible-looking responses at /wp-login.php, /wp-admin/, /xmlrpc.php,
// /wp-json/ etc. so platform fingerprinting tools (Wappalyzer, BuiltWith, etc.)
// classify the origin as WordPress. This is purely passive - no logging, no
// auto-blocking. The goal is misdirection: automated scanners burn time on
// WP-specific exploits that won't work because there's no WP here. Mounted
// AFTER /admin (which is registered earlier above) so real admin routes are
// never shadowed; mounted BEFORE the catch-all root-path handler so a
// campaign at root_path='wp-login' can't ever conflict (the regex wouldn't
// allow the dot anyway, but defense in depth).
const { router: wpFingerprintRouter } = require('./lib/wpFingerprint');
app.use('/', wpFingerprintRouter);

// --- Custom root-path campaign routes ---
// Campaigns can opt-in to a custom root path like /promo or /black-friday-2026
// in addition to the default /go/<slug>. This is registered AFTER all explicit
// system routes (admin, site pages, healthz) so a campaign at /privacy could
// never shadow the site page. Defense-in-depth: the handler also rejects any
// path that's in the reserved-paths registry, even if validation at create
// time somehow let one through.
//
// The route regex requires a single segment matching [a-z0-9][a-z0-9_-]{1,63}
// so multi-segment paths (/foo/bar), uppercase, special characters, and
// dot-files won't match here - they'll fall through to the 404 handler.
const { isReservedPath } = require('./lib/reservedPaths');
const { handleClick: goHandleClick } = require('./routes/go');
const { DEFAULT_SLUG: DEFAULT_WS_SLUG } = require('./lib/bootstrap');

app.get(/^\/([a-z0-9][a-z0-9_-]{1,63})$/, async (req, res, next) => {
  const candidate = req.params[0];
  // Defensive: if a reserved path somehow got past validation, return 404
  // rather than serving the campaign. This protects future system routes too.
  if (isReservedPath(candidate)) return next();
  return goHandleClick(req, res, {
    workspaceSlug: DEFAULT_WS_SLUG,
    lookupKind: 'root_path',
    lookupValue: candidate,
  });
});

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

// ── Mongo connection pool tuning ─────────────────────────────────────────
// Explicit, bounded settings so heavy traffic doesn't exhaust connections or
// hang on a slow Mongo. With clustering, each worker gets its own pool, so
// the total is workers × maxPoolSize (e.g. 4 × 20 = 80 — well within Mongo's
// default 128 max).
//
// Env overrides (optional):
//   MONGO_POOL_SIZE             — connections per process (default 20)
//   MONGO_SERVER_SELECTION_MS   — how long to wait for a primary (default 5000)
//   MONGO_SOCKET_TIMEOUT_MS    — idle socket timeout (default 45000)
// ─────────────────────────────────────────────────────────────────────────
function mongoOptions() {
  return {
    maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE, 10) || 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: parseInt(process.env.MONGO_SERVER_SELECTION_MS, 10) || 5000,
    socketTimeoutMS: parseInt(process.env.MONGO_SOCKET_TIMEOUT_MS, 10) || 45000,
    heartbeatFrequencyMS: 10000,
    retryWrites: true,
  };
}

// Single-process startup (used when CLUSTER_WORKERS=1 or clustering is off).
// Runs everything: Mongo, background jobs, Express. In clustered mode, workers
// use startWorker() instead and the master runs background jobs separately.
async function start() {
  await mongoose.connect(process.env.MONGO_URI, mongoOptions());
  logger.info('mongo_connected', { uri: process.env.MONGO_URI });

  await ensureDefaultWorkspace();

  try {
    const { seedFrequencyLabels } = require('../scripts/seedFrequencyLabels');
    const result = await seedFrequencyLabels();
    if (!result.skipped) logger.info('freq_label_backfill_complete', result);
  } catch (e) { logger.warn('freq_label_backfill_failed', { err: e.message }); }

  try {
    const { startCidrAnalyser, startWeeklyRefresh } = require('./lib/cidrAnalyser');
    startCidrAnalyser();
    startWeeklyRefresh();
  } catch (e) { logger.warn('cidr_analyser_start_failed', { err: e.message }); }

  try {
    const { live } = require('./lib/livePresence');
    const { startDwellWriteback } = require('./lib/dwellWriteback');
    startDwellWriteback(live);
  } catch (e) { logger.warn('dwell_writeback_start_failed', { err: e.message }); }

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    logger.info('server_started', { port, base_url: process.env.BASE_URL });
    // Start live-presence sync (Redis pub/sub) so the admin dashboard
    // shows all visitors even if clustering is enabled later.
    try {
      const { live } = require('./lib/livePresence');
      const liveSync = require('./lib/liveSync');
      liveSync.start(live);
    } catch (e) { logger.debug('live_sync_skip', { err: e.message }); }
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });
    server.close((err) => {
      if (err) logger.error('server_close_error', { err: err.message });
      else logger.info('server_closed');
      mongoose.connection.close(false).then(() => {
        logger.info('mongo_closed');
        process.exit(0);
      }).catch((e) => {
        logger.error('mongo_close_error', { err: e.message });
        process.exit(1);
      });
    });
    setTimeout(() => {
      logger.error('shutdown_timeout_forcing_exit');
      process.exit(1);
    }, 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ── Clustering ───────────────────────────────────────────────────────────
// Use all available CPU cores so the single-threaded event loop isn't a
// bottleneck under heavy traffic. Each worker is a full Express server
// sharing the same port.
//
// Env:
//   CLUSTER_WORKERS  — explicit worker count. Takes precedence over auto.
//                      Set to 1 to disable clustering (single-process mode).
//   (unset)          — auto-detect: min(os.cpus().length, 4).
//
// Background jobs (CIDR analyser, dwell writeback, frequency backfill) run
// in the MASTER only so they aren't duplicated across workers.
// ─────────────────────────────────────────────────────────────────────────

const cluster = require('cluster');
const os = require('os');

function getWorkerCount() {
  const env = parseInt(process.env.CLUSTER_WORKERS, 10);
  if (Number.isFinite(env) && env >= 1) return env;
  return Math.min(os.cpus().length, 4);
}

if (cluster.isPrimary) {
  const workers = getWorkerCount();

  if (workers <= 1) {
    // Single-process mode — run everything in one process (previous behavior).
    start().catch((err) => {
      logger.error('startup_failed', { err: err.message, stack: err.stack });
      process.exit(1);
    });
  } else {
    logger.info('cluster_master', { pid: process.pid, workers });

    // Master: run background jobs only (no Express/listen).
    (async () => {
      try {
        await mongoose.connect(process.env.MONGO_URI, mongoOptions());
        logger.info('master_mongo_connected');
        await ensureDefaultWorkspace();

        // Frequency backfill (one-time, idempotent).
        try {
          const { seedFrequencyLabels } = require('../scripts/seedFrequencyLabels');
          const result = await seedFrequencyLabels();
          if (!result.skipped) logger.info('freq_label_backfill_complete', result);
        } catch (e) { logger.warn('freq_label_backfill_failed', { err: e.message }); }

        // CIDR intelligence + dwell writeback — master-only.
        try {
          const { startCidrAnalyser, startWeeklyRefresh } = require('./lib/cidrAnalyser');
          startCidrAnalyser();
          startWeeklyRefresh();
        } catch (e) { logger.warn('cidr_analyser_start_failed', { err: e.message }); }

        try {
          const { live } = require('./lib/livePresence');
          const { startDwellWriteback } = require('./lib/dwellWriteback');
          startDwellWriteback(live);
        } catch (e) { logger.warn('dwell_writeback_start_failed', { err: e.message }); }
      } catch (err) {
        logger.error('master_startup_failed', { err: err.message });
        process.exit(1);
      }
    })();

    // Fork workers.
    for (let i = 0; i < workers; i++) cluster.fork();

    // Restart crashed workers automatically.
    cluster.on('exit', (worker, code, signal) => {
      logger.warn('cluster_worker_exit', { pid: worker.process.pid, code, signal });
      if (code !== 0) {
        logger.info('cluster_worker_respawn');
        cluster.fork();
      }
    });

    // Graceful shutdown: forward SIGTERM to workers, then exit master.
    ['SIGTERM', 'SIGINT'].forEach((sig) => {
      process.on(sig, () => {
        logger.info('cluster_master_shutdown', { signal: sig });
        for (const id in cluster.workers) {
          cluster.workers[id].process.kill(sig);
        }
        setTimeout(() => process.exit(0), 12000).unref();
      });
    });
  }
} else {
  // Worker: run Express (skip background jobs — master handles those).
  startWorker().catch((err) => {
    logger.error('worker_startup_failed', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}

/**
 * Worker-only startup: connect Mongo, listen on the port, handle shutdown.
 * Skips background jobs (CIDR, dwell, backfill) — those run in the master.
 */
async function startWorker() {
  await mongoose.connect(process.env.MONGO_URI, mongoOptions());
  logger.info('worker_mongo_connected', { pid: process.pid });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    logger.info('worker_started', { pid: process.pid, port });
    // Start live-presence sync — syncs visitors across cluster workers
    // via Redis pub/sub so the admin live dashboard sees all visitors.
    try {
      const { live } = require('./lib/livePresence');
      const liveSync = require('./lib/liveSync');
      liveSync.start(live);
    } catch (e) { logger.debug('live_sync_skip', { err: e.message }); }
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker_shutdown', { pid: process.pid, signal });
    server.close((err) => {
      if (err) logger.error('server_close_error', { err: err.message });
      mongoose.connection.close(false).then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
