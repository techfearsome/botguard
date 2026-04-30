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
const adminRoutes = require('./routes/admin');
const siteRoutes = require('./routes/site');

const app = express();

// Trust proxy for correct IP detection behind Cloudflare/nginx
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// --- Hot path routes (the actual landing page traffic) ---
app.use('/go', goRoutes);
app.use('/px', pixelRoutes);
app.use('/cb', postbackRoutes);

// --- Admin panel (scoped per workspace, multi-tenant ready) ---
app.use('/admin', adminRoutes);

// --- Public site pages (homepage, privacy, terms, /p/:slug) ---
// Mounted AFTER /admin so /admin doesn't get caught by the / handler.
// When no SitePage is configured, these fall through to a real 404 (not the admin login).
app.use('/', siteRoutes);

// Health check
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 404
app.use((req, res) => {
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
  app.listen(port, () => {
    logger.info('server_started', { port, base_url: process.env.BASE_URL });
  });
}

start().catch((err) => {
  logger.error('startup_failed', { err: err.message, stack: err.stack });
  process.exit(1);
});
