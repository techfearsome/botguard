# BotGuard Deployment Guide

This guide covers three deployment paths: **Coolify** (self-hosted PaaS, recommended), **Heroku**, and **Azure App Service**.

For all three paths, you'll need:
- Your code in a Git repository (GitHub recommended)
- A MongoDB instance (Atlas free tier is fine to start; self-hosted works too)
- A strong `SESSION_SECRET` and `ADMIN_PASSWORD` set in env vars

---

## Setting your admin password

Before deploying, decide how to set the admin password.

### Option A: Plain `ADMIN_PASSWORD` env var (easy, fine for small deployments)

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-strong-password-here
```

The password is hashed with scrypt in memory at server startup. It's never written to disk in plaintext, but it does sit in your hosting provider's env-var config.

### Option B: Pre-hashed `ADMIN_PASSWORD_HASH` (recommended for production)

Generate a hash locally (no need to deploy anything yet):

```bash
npm install
npm run hash-password
# Enter your password when prompted - it'll print the hash
```

Or one-shot:

```bash
npm run hash-password -- 'my-strong-password'
```

You'll get something like:

```
b2f4a8e12c4d6e89...:9a8b7c6d5e4f3a2b...
```

Then set `ADMIN_PASSWORD_HASH` (NOT `ADMIN_PASSWORD`) in your hosting provider's env config to that string. The plaintext password never leaves your machine.

### Generating SESSION_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the output as `SESSION_SECRET`. It signs admin login cookies — losing or rotating it logs everyone out, so save it somewhere safe (1Password, etc.).

### After first login

Visit `/admin/login`, log in with your credentials, then go to **Settings** to:
- Generate API keys for postback authentication
- See workspace info
- Read the password-rotation steps

---

## Running behind Cloudflare

BotGuard is designed to run behind Cloudflare. A few config items matter for correct behavior:

### Required environment variables

```
TRUST_PROXY=cloudflare
```

This restricts trust to Cloudflare's documented IP ranges. Without it, `req.ip` would show the Cloudflare edge IP instead of the visitor's real IP, and the entire filter chain would score one bot signal (datacenter IP) instead of the actual visitor's signals.

### Cloudflare dashboard configuration

**SSL/TLS mode:** Set to **Full (strict)**. Your origin should have a real cert (Coolify auto-provisions Let's Encrypt; Heroku and Azure handle it automatically).

**Caching rules:** BotGuard sets `Cache-Control: no-store` and `CDN-Cache-Control: no-store` on every dynamic response (`/go/*`, `/px/*`, `/cb/*`, `/admin/*`), so Cloudflare's default caching behavior is correct out of the box. **Do not** create a Page Rule that caches `/go/*` — every visitor must get a fresh `click_id` cookie.

If you're using a Cloudflare Page Rule for static assets at `/static/*`, you can safely set:
- Cache Level: **Standard** or **Cache Everything**
- Edge Cache TTL: **1 day** or longer

The app already sends `Cache-Control: public, max-age=86400` for static files.

**Bot Fight Mode:** Leave it OFF. Cloudflare's bot challenges interfere with the JS challenge in BotGuard's behavioral fingerprinting. If you want Cloudflare-level protection, use **Super Bot Fight Mode** with the "Definitely automated" rule set to "Block" — that catches the obvious-bot category before BotGuard sees them, which lowers your ProxyCheck quota usage.

**Rocket Loader / Auto Minify:** Disable for `/go/*` paths. They modify HTML inline, which can break landing page tracking pixels embedded by clients.

### Country detection without ProxyCheck quota

When you don't have a ProxyCheck API key (or your quota is exhausted), BotGuard automatically falls back to Cloudflare's `CF-IPCountry` header for country information. This is free with any Cloudflare plan and gets you country-level filtering without any external API calls.

Cities and regions require Cloudflare Enterprise (`CF-IPCity`, `CF-Region` headers) and are also used as fallback when present.

The special `CF-IPCountry: T1` value (Tor exit) is honored — it flips the proxy verdict to TOR even when ProxyCheck didn't catch it.

### Real visitor IP

Cloudflare sets `CF-Connecting-IP` on every request with the visitor's real IP. BotGuard uses this as the highest-priority IP source, falling back to `X-Real-IP` and then `req.ip`. With `TRUST_PROXY=cloudflare`, Express trusts these headers only when the upstream connection comes from a Cloudflare edge IP — preventing header spoofing from anyone bypassing Cloudflare and hitting your origin directly.

For maximum security, also configure your hosting provider's firewall to **only accept connections from Cloudflare IP ranges** on port 443. Coolify supports this via Traefik labels; on Heroku and Azure it requires custom WAF rules.

### Performance with Redis

When `REDIS_URL` is set, BotGuard uses Redis for:
- **Rate limiting** (per IP, per ASN, per fingerprint counters) — required for the pattern filter to function
- **Campaign and workspace caching** — the `/go/:slug` hot path caches the workspace + campaign lookups for 60 seconds, dramatically reducing Mongo query load on traffic spikes
- **ProxyCheck verdict caching** — IP lookups are cached for 6 hours, so repeat visitors don't burn ProxyCheck quota

Without Redis, the system still works:
- Rate limiting silently no-ops (no per-IP throttling)
- Campaign cache falls back to in-memory (per-instance, doesn't share across replicas)
- ProxyCheck cache falls back to in-memory

For a single-instance deployment behind Cloudflare, you can run without Redis and still handle a few hundred clicks/sec because Cloudflare absorbs most of the traffic. If you scale to multiple instances or expect sustained high traffic, run Redis.

**Capacity estimate for a single t3.small/CX22-class instance:**

| With Redis | Without Redis |
|---|---|
| ~200-500 clicks/sec sustained | ~50-100 clicks/sec sustained |
| Mongo writes are the bottleneck | Mongo reads + writes are the bottleneck |
| Rate limiting works correctly | No rate limiting |

Past those numbers, scale horizontally (multiple BotGuard instances behind the same Cloudflare hostname) and run Redis as a shared cache.

---

## Path 1: Coolify (recommended)

Coolify is a self-hosted PaaS — like Heroku/Render but you run it on your own VPS. For BotGuard's use case (stateful Mongo, Redis, full filesystem access), it's a much better fit than Heroku and roughly 1/10 the cost.

### Why Coolify for BotGuard
- Free to self-host, runs on a $6/mo Hetzner CX22 (2 vCPU / 4 GB RAM) and you can host BotGuard + MongoDB + Redis + a few other apps on the same box
- Built-in one-click MongoDB and Redis containers — no Atlas dependency required
- Auto SSL via Let's Encrypt, push-to-deploy from GitHub
- Full Docker access for when you need to step outside the platform

### One-time Coolify setup

```bash
# On a fresh Ubuntu 22.04 / 24.04 VPS (root user)
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Wait 2–5 minutes. It installs Docker, sets up the Coolify containers, and exposes the admin UI at `http://<your-server-ip>:8000`. Open that, create your Coolify admin account (this is separate from BotGuard's admin).

Point a subdomain at the server (e.g. `coolify.yourdomain.com` → server IP), then in Coolify go to **Settings → Instance Settings** and set the Coolify URL. SSL gets set up automatically.

### Deploy MongoDB

1. **Projects → New Project** → name it `BotGuard`
2. Inside the project: **+ New → Database → MongoDB**
3. Pick a name (e.g. `botguard-mongo`), keep defaults
4. Click **Start**
5. From the database page, copy the **Internal connection string** (looks like `mongodb://user:pass@botguard-mongo:27017`)
6. Don't expose the database publicly — keep it on the internal Docker network

### Deploy Redis (optional but recommended)

Same flow: **+ New → Database → Redis**. Copy the internal connection string (`redis://botguard-redis:6379`).

### Deploy BotGuard

1. **+ New → Public Repository** (or **GitHub App** if you want auto-deploy on push)
2. Paste your repo URL
3. Build pack: **Nixpacks** (auto-detects Node.js) — or **Dockerfile** if you prefer the included one
4. Port: `3000`
5. Domain: pick a subdomain (e.g. `bg.yourdomain.com`); Coolify auto-issues an SSL cert via Let's Encrypt

### Set environment variables

In the BotGuard application page in Coolify, go to **Environment Variables** and add:

```
NODE_ENV=production
PORT=3000
BASE_URL=https://bg.yourdomain.com
TRUST_PROXY=1

MONGO_URI=<paste internal connection string from MongoDB step>
REDIS_URL=<paste internal connection string from Redis step>

SESSION_SECRET=<your generated 64-char hex string>
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<your generated hash>

DEFAULT_WORKSPACE_SLUG=techfirio
PROXYCHECK_API_KEY=<your proxycheck.io key>
```

### Deploy

Click **Deploy**. Watch the build logs — first build takes 2–4 minutes. After it's running, visit `https://bg.yourdomain.com/admin/login`, sign in, run the seed via the Coolify terminal:

```bash
# In Coolify: app page → Terminal tab
node scripts/seed.js
```

You're live.

---

## Path 2: Heroku

Heroku has no free tier anymore. Cheapest viable production setup as of 2026:
- **Eco dyno** $5/mo (sleeps after 30 min — fine for low-traffic, bad for click tracking which needs to respond instantly)
- **Basic dyno** $7/mo (always on, 512 MB RAM — recommended for BotGuard)
- **MongoDB** — Heroku doesn't have managed Mongo anymore; use **MongoDB Atlas free tier** (M0, 512 MB, free)
- **Redis** — Heroku Key-Value Store Mini $3/mo, or use Redis Cloud free tier (30 MB free)

Total: ~$7/mo with Atlas free + Redis free, which is reasonable for a tracking tool.

### Steps

1. Create a [MongoDB Atlas](https://cloud.mongodb.com) account, spin up a free M0 cluster, create a DB user, whitelist `0.0.0.0/0` (Heroku dynos have dynamic IPs), grab the connection string.

2. Install the Heroku CLI and log in:
   ```bash
   heroku login
   ```

3. From the project directory:
   ```bash
   git init  # if not already a git repo
   git add .
   git commit -m "initial deploy"

   heroku create botguard-yourname
   heroku stack:set heroku-22

   # Set config
   heroku config:set NODE_ENV=production
   heroku config:set TRUST_PROXY=1
   heroku config:set MONGO_URI='mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/botguard?retryWrites=true&w=majority'
   heroku config:set SESSION_SECRET='<your 64-char hex>'
   heroku config:set ADMIN_USERNAME=admin
   heroku config:set ADMIN_PASSWORD_HASH='<your hash>'
   heroku config:set DEFAULT_WORKSPACE_SLUG=techfirio
   heroku config:set PROXYCHECK_API_KEY='<your key>'

   # Optional: Redis (skip if you don't need rate limiting)
   heroku addons:create heroku-redis:mini
   # REDIS_URL is auto-injected. BotGuard will pick it up.

   # BASE_URL points at the Heroku-issued domain by default
   heroku config:set BASE_URL=https://botguard-yourname.herokuapp.com

   # Deploy
   git push heroku main   # or master, depending on your branch
   ```

4. Upgrade to Basic dyno (Eco sleeps and that's bad for click tracking):
   ```bash
   heroku ps:type web=basic
   ```

5. Seed the database:
   ```bash
   heroku run node scripts/seed.js
   ```

6. Visit `https://botguard-yourname.herokuapp.com/admin/login` and sign in.

### Custom domain on Heroku

```bash
heroku domains:add bg.yourdomain.com
# Heroku gives you a DNS target like xyz.herokudns.com
# Point a CNAME record from bg.yourdomain.com → that target
heroku certs:auto:enable   # auto-SSL via Let's Encrypt
heroku config:set BASE_URL=https://bg.yourdomain.com
```

### Heroku gotchas to know
- **No persistent filesystem.** Anything BotGuard writes locally is wiped on restart. We don't write any local files (everything is in Mongo), so this is fine.
- **Dyno sleeping** on Eco — your `/go/:slug` route will have a cold-start delay of 5–10 seconds when it wakes. Use Basic ($7) instead.
- **30-second request timeout.** ProxyCheck calls have a 1.5s timeout already so this is fine.
- **Logs are ephemeral.** Pipe them somewhere (Papertrail, Logtail) if you want history.

---

## Path 3: Azure App Service

Azure is the most enterprise-y option. The Microsoft tutorial uses **Cosmos DB with the MongoDB API** as the database, which is a fully-managed service that speaks Mongo wire protocol. That works with our Mongoose code without changes.

### Resources you'll create
- **Resource group** — logical container
- **App Service plan** — compute (Basic B1 ≈ $13/mo is the cheapest production tier)
- **App Service** — your Node.js app
- **Cosmos DB** with **MongoDB API** — your database (~$24/mo entry tier, or use serverless for lower traffic)
- **Key Vault** (optional) — store secrets like `MONGO_URI` and `ADMIN_PASSWORD_HASH` outside the app's config

### Easiest path: Azure portal click-through

Microsoft has a [step-by-step tutorial](https://learn.microsoft.com/en-us/azure/app-service/tutorial-nodejs-mongodb-app) that creates all of this for you in one wizard. Pick:
- **Runtime stack**: Node 20 LTS or Node 24 LTS
- **Engine**: Cosmos DB API for MongoDB
- **Hosting plan**: Basic (B1)
- Note the auto-generated database name like `<your-app>-database`

Once provisioned, hook up GitHub deployment under **Deployment Center** — pick GitHub Actions, point it at your repo, branch `main`, and Azure will auto-build and deploy on every push.

### Set environment variables (App Settings)

In the App Service, go to **Settings → Environment variables** and add:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (Azure also sets this automatically) |
| `BASE_URL` | `https://<your-app>.azurewebsites.net` |
| `TRUST_PROXY` | `1` |
| `MONGO_URI` | The Cosmos DB connection string (already injected as `AZURE_COSMOS_CONNECTIONSTRING` — just rename or alias it) |
| `SESSION_SECRET` | Your 64-char hex string |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD_HASH` | Your hash |
| `DEFAULT_WORKSPACE_SLUG` | `techfirio` |
| `PROXYCHECK_API_KEY` | Your key |

If you want to alias `AZURE_COSMOS_CONNECTIONSTRING` to `MONGO_URI` instead of adding a new env, you can either set both or modify `src/server.js`:

```js
await mongoose.connect(process.env.MONGO_URI || process.env.AZURE_COSMOS_CONNECTIONSTRING);
```

### Cosmos DB MongoDB API specifics

The Cosmos DB MongoDB API is a managed Mongo-compatible service, but it has some gotchas:

- **Request Units (RUs)** are how it bills — every read and write consumes RUs. Our click-write rate (one INSERT per click) is light, but the dashboard's aggregation queries can be RU-heavy. Start with serverless mode (pay per request, no minimum) — it's the right fit for traffic that's bursty.
- **Index everything you query.** Mongo Atlas lets you get away with unindexed queries; Cosmos doesn't and will throw `429 Too Many Requests` if you blow your RU budget. Our `Click` model is well-indexed already, but watch out.
- **Connection strings start with** `mongodb://...documents.azure.com:10255/...?ssl=true&...` — note the SSL requirement. Mongoose handles this automatically when using the connection string.

### Run the seed

In App Service, open **Development Tools → SSH** and run:

```bash
node scripts/seed.js
```

### Custom domain + SSL

Under **Settings → Custom domains** in your App Service. Add your domain, validate via TXT/CNAME record, then bind a free **App Service Managed Certificate**.

---

## Comparison: which to pick?

| Factor | Coolify | Heroku | Azure |
|---|---|---|---|
| **Monthly cost** (small) | ~$6 (VPS only) | $7 (Basic dyno) + Atlas free | ~$37 (B1 + Cosmos serverless) |
| **Setup time** | 30 min (incl. Coolify install) | 10 min | 30 min |
| **DevOps overhead** | Some (you maintain the VPS) | None | Low |
| **Push-to-deploy** | Yes (GitHub integration) | Yes (`git push heroku`) | Yes (GitHub Actions) |
| **Auto SSL** | Yes (Let's Encrypt) | Yes (free certs) | Yes (App Service Managed Cert) |
| **Mongo included** | Yes (one-click) | No (use Atlas free) | Yes (Cosmos DB MongoDB API) |
| **Redis included** | Yes (one-click) | $3/mo Mini (or Redis Cloud free) | Add-on, $$ |
| **Best for** | TechFirio, single founder | Quick prototype / MVP | Enterprise / regulatory needs |

**My recommendation for your use case (TechFirio, internal-first, planning to SaaS later):** **Coolify on Hetzner**. You already use Hetzner, the cost is the lowest, and the migration to multi-tenant SaaS later is easier when you control the infrastructure. Atlas-managed Mongo is fine, but Coolify's built-in Mongo is good enough until you outgrow a single VPS.

---

## Post-deployment checklist

- [ ] `BASE_URL` is set to the actual public URL (used for postback links shown in the admin UI)
- [ ] `TRUST_PROXY=1` is set (so `req.ip` reflects real client IP, not the load balancer)
- [ ] You verified `/healthz` returns `{ ok: true }` — used by the platform's health check
- [ ] You logged into `/admin/login` and the cookie persists across page loads (proves `SESSION_SECRET` is stable)
- [ ] You generated at least one API key under **Settings** for postback auth
- [ ] You added your `PROXYCHECK_API_KEY` if you want network-layer scoring
- [ ] You sent test traffic to `/go/demo` and saw it appear in the click log
- [ ] You ran the seed script (or created campaigns manually in the UI)
- [ ] If using Coolify with internal-only Mongo: you confirmed the database is **NOT** publicly exposed
- [ ] You changed `DEFAULT_WORKSPACE_SLUG` from the default to something specific to you (it appears in URLs like `/admin/<slug>/...`)

## Capacity planning (especially for shared VPS)

**At 10–100 visitors/min** (typical small-to-mid affiliate / lead-gen scale): a 4 GB shared VPS is plenty, even with other apps on the box. Realistic resource use:

| Metric | Idle | Sustained 100 visits/min |
|---|---|---|
| Node memory (RSS) | ~150 MB | ~250 MB |
| CPU (1 core) | <1% | <3% |
| Mongo ops/sec | trivial | ~6 ops/sec |
| Network out | trivial | ~150 KB/s |

**At 500–2,000 visitors/min** you'll want Redis enabled (campaign/workspace cache, ~90% Mongo offload) and a dedicated 1 GB+ Mongo. ~150 visits/sec is doable on the same box if you're disciplined about resource caps.

**At 2,000+ visitors/min** put BotGuard on its own box, scale Mongo separately, and put Redis on a low-latency network with the app.

### Coolify-specific knobs for shared boxes

If you're on a 4 GB box shared with other apps, set these to prevent any one service eating everything:

1. **Per-service memory limit** in Coolify: BotGuard → Settings → Resources → Memory limit `512 MB`, Memory reservation `256 MB`. The Dockerfile already caps Node's heap at 384 MB via `NODE_OPTIONS`, so the container will never request more than 512 MB total.

2. **Cap Mongo's WiredTiger cache.** Mongo defaults to 50% of system RAM, which on a 4 GB box means it'll grab 2 GB and starve everything else. In your Mongo service env: `MONGO_INITDB_DATABASE=botguard` plus a custom command:
   ```
   mongod --wiredTigerCacheSizeGB 0.5
   ```
   Or via `mongod.conf`:
   ```yaml
   storage:
     wiredTiger:
       engineConfig:
         cacheSizeGB: 0.5
   ```

3. **Cap Redis memory.** Redis is great but can grow. Set `maxmemory 128mb` and `maxmemory-policy allkeys-lru` in its config. BotGuard uses Redis for transient caching (60s TTL), so LRU eviction is safe.

4. **Add 2 GB swap** as insurance against OOM kills:
   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

5. **Restart policy: `unless-stopped`** in Coolify. Prevents flapping if a single OOM does happen.

### Graceful shutdown

The app installs SIGTERM/SIGINT handlers that:
1. Stop accepting new connections
2. Let in-flight requests finish (up to 10s)
3. Close Mongo cleanly
4. Exit cleanly

Coolify rolling deploys won't drop visitor requests as long as your healthcheck is wired (the Dockerfile already includes `/healthz`). Make sure Coolify is configured to wait for the new container to pass healthcheck before stopping the old one (the default).

### Recommended Coolify configuration

In Coolify's environment variables for BotGuard:

| Variable | Value | Reason |
|---|---|---|
| `NODE_ENV` | `production` | Disables verbose logging, enables compression |
| `TRUST_PROXY` | `cloudflare` | Required if behind Cloudflare; otherwise `1` |
| `MONGO_URI` | `mongodb://mongo:27017/botguard` | Internal Coolify Mongo service |
| `REDIS_URL` | `redis://redis:6379` | Internal Coolify Redis service (optional but recommended for >50 visitors/min) |
| `SESSION_SECRET` | (random 32+ chars) | `openssl rand -hex 32` |
| `ADMIN_USERNAME` | (your choice) | |
| `ADMIN_PASSWORD` | (long passphrase) | Hashed at startup; never logged |
| `PROXYCHECK_API_KEY` | (from proxycheck.io) | Required for IP enrichment |
| `BASE_URL` | `https://yourdomain.com` | Used in absolute URLs |

## Troubleshooting

**Login redirects you back to login.** SESSION_SECRET probably isn't set or is too short (must be ≥16 chars). Check `heroku logs` / Coolify logs / Azure log stream — the server logs `login_no_credentials_configured` if `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars aren't set.

**`/admin` returns 404 or 500.** Check that Mongo is reachable. The bootstrap step (`ensureDefaultWorkspace`) runs on first request and will fail loudly if Mongo connection isn't ready.

**Clicks aren't getting an ASN/country/etc.** Means `PROXYCHECK_API_KEY` isn't set. The system falls back to ASN-blacklist and other layers gracefully, but network enrichment requires the key.

**`req.ip` shows the load balancer's IP, not the user's.** Set `TRUST_PROXY=1`. On Heroku and Azure App Service this is required because they sit behind their own reverse proxies.

**Conversion pixel returns 200 but the click can't be found.** The pixel needs the `cid` query param OR the `bg_cid` cookie. If your conversion is on a different domain than your landing page, the cookie won't be sent — pass `?cid=` explicitly.
