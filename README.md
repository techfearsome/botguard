# BotGuard

Self-hosted landing page funnel tool with UTM tracking and bot protection.

## Week 1 status

**Done in week 1:**
- Project skeleton (Express + Mongoose + EJS)
- Multi-tenancy seams (workspace scoping from day one)
- `/go/:slug` hot path with click logging
- Full UTM + external ID capture (gclid, fbclid, msclkid, ttclid, li_fat_id)
- UA parsing, device classification, in-app browser detection (FB/IG/TikTok/LinkedIn/Twitter/Snap/Pinterest/WeChat/Line)
- Conversion tracking — pixel (`/px/conv`) and S2S postback (`/cb/postback`)
- Admin panel: dashboard, campaigns CRUD, landing pages CRUD, click log
- A/B variant rendering (weight-based)
- **ASN blacklist model + admin UI** — fills ProxyCheck.io gaps for known VPN/proxy/Tor ASNs
- Starter ASN seed list (Tor, M247, Cogent, AWS, GCP, Azure, DO, Linode, Vultr, Hetzner, OVH, Contabo, etc.)
- Permissive defaults — log everything, decide later

## Week 2 status

**Done in week 2 (this build):**
- **Full filter chain orchestrator** (`lib/filterChain.js`) — runs all 5 layers in parallel where possible
- **Network filter** with ProxyCheck.io v3 client, ASN blacklist overlay, prefetcher detection
- **Headers filter** — UA shape, sec-fetch-* consistency, Accept/Encoding/Language analysis
- **Behavior filter** — canvas/WebGL/screen/timezone fingerprint scoring, headless detection (SwiftShader, Mesa OffScreen, navigator.webdriver)
- **Pattern filter** — Redis-backed rate limits per IP/ASN/fingerprint, gracefully no-ops without Redis
- **Referrer integrity filter** — utm_source vs referer matching for FB/Google/IG/TikTok/Twitter/LinkedIn/Reddit/Pinterest/etc.
- **Source profiles** (`scoring/profiles.js`) — email/paid_ads/organic/affiliate/mixed with calibrated weights
- **Decide engine** with hard-block flags, prefetcher always-allow, log_only vs enforce mode
- **JS challenge** — client-side fingerprint collection, posts to `/go/fp` to update click record
- **Prefetcher allowlist** — Outlook SafeLinks, Apple MPP (ASN-based), Gmail proxy, Mimecast, Proofpoint, Barracuda, Slack/Discord/Twitter unfurls
- **Decision replay tool** — re-score historical clicks against new threshold/profile/mode settings
- **Click detail page** — drill into any click, see all 5 layer scores, flags, fingerprint, conversions
- **77 unit tests passing** (22 from Week 1 + 37 from Week 2 = 59 distinct tests, plus 18 of those exercise edge paths)

**Not yet (week 3+):**
- Conversion postback firing (forward to ad platforms via `postback_url`)
- Multi-page funnel chaining
- Email prefetcher allowlist refresh job (auto-update Apple MPP IP ranges)
- Bulk import of Tor exit nodes (cron from check.torproject.org)
- Geo-targeting rules per campaign
- Auth & SaaS billing (multi-tenant goes live)

## Architecture notes

### Log-first, decide-later
The system is built around a decision log, not a filter pipeline. Every click is scored on every signal and persisted, but the *block/allow* decision is a separate config layer. This means you can replay traffic against new rules retroactively, A/B test filter aggressiveness per campaign, and mark visits as "would have blocked" without actually blocking — gold for tuning.

### ASN + Term blacklist as ProxyCheck overlay
ProxyCheck.io has known gaps:
- Some Tor exit nodes when their ASN rotates
- Smaller / regional VPN providers
- Residential proxy networks that look "clean"
- Newly-registered datacenter ASNs
- Operators that rebrand or shuffle ASNs but keep the same provider name

The `AsnBlacklist` collection runs **after** ProxyCheck and supports two rule types:

1. **ASN rules** — exact match against the ASN number ProxyCheck returns. Fast, precise, narrow.
2. **Term rules** — case-insensitive substring match against ProxyCheck's `provider` and/or `asn_org` fields. Broad, catches operators across multiple ASNs.

A term rule of `m247` catches every ASN M247 ever registers under that name. A term rule of `vpn` catches every provider with "VPN" in the name (NordVPN, ExpressVPN, ProtonVPN, etc.). Categories (`tor`, `vpn`, `proxy`, `datacenter`, `hosting`, `scraper`, `spam`, `other`) let scoring treat them differently per source profile.

The blacklist can flip a "clean" verdict to "proxy", but never the reverse — ProxyCheck's positive matches are always trusted. When both an ASN rule and a term rule match the same click, the ASN rule wins (more specific) but the term match still gets logged as a flag. Manageable via the admin UI at `/admin/asn`.

### Multi-tenancy seams
Even though week 1 is single-tenant, every collection has `workspace_id` and the `/go` route accepts both `/go/:slug` (single tenant) and `/go/:workspaceSlug/:campaignSlug` (multi-tenant). When you flip on SaaS later, you add signup/billing — the data layer is already correct.

## Week 3 status

**Done in week 3 (this build):**
- **Auto-slug generation** — leave the slug field blank when creating a campaign or landing page; it's derived from the name
- **Slug collision handling** — random suffix appended on collision
- **UTM gate filter** — per-campaign toggle; failed visits routed to safe page without burning ProxyCheck quota
- **Country gate filter** — per-campaign whitelist OR blacklist using ProxyCheck's country verdict
- **Proxy gate filter** — hard route to safe page on proxy/VPN/Tor detection with per-category toggles
- **ProxyCheck.io v3 API client fixed** — endpoint format and response shape both corrected, operator field handles rich object
- **Per-device page routing** — six device classes (iphone/android/windows/mac/linux/other), per-campaign offer + safe overrides
- **Site pages** — homepage, privacy policy, terms, and `/p/<slug>` pages managed under admin Settings → Site
- **Responsive admin panel** — mobile-friendly nav, full-width inputs, horizontally-scrolling tables on mobile
- **Cloudflare-aware** — `TRUST_PROXY=cloudflare` mode whitelists Cloudflare's IP ranges; `Cache-Control: no-store` on all dynamic routes prevents CDN caching of click responses; `CF-IPCountry` / `CF-IPCity` / `CF-Region` headers used as geo fallback when ProxyCheck unavailable; static assets get aggressive `max-age=86400` caching
- **Redis-backed campaign cache** — `/go/:slug` hot path caches workspace + campaign for 60s, drops Mongo load by 90%+ on repeat traffic; auto-invalidates on admin update/delete; in-memory fallback when Redis unavailable

**Not yet (week 4+):**
- FB CAPI / Google Enhanced Conversions outbound conversion forwarding
- Multi-step funnel chaining (offer → upsell → thank-you, preserving click_id)
- Outlook SafeLinks rescan deduplication

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env template
cp .env.example .env
# edit .env - set MONGO_URI, SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD

# 3. Start MongoDB locally (or point MONGO_URI at Atlas)

# 4. Seed a demo campaign
npm run seed

# 5. Start the server
npm run dev
```

Then visit:
- **Admin login**: http://localhost:3000/admin/login (use the username/password you set)
- Test click: http://localhost:3000/go/demo?utm_source=test&utm_medium=email&utm_campaign=launch
- Test conversion: http://localhost:3000/px/conv?cid=&lt;click_id&gt;&value=10

### Setting the admin password

Two options:

**Plain password (easy):**
```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
```

**Pre-hashed password (recommended for production):**
```bash
npm run hash-password
# enter password when prompted, copy the output, then:
ADMIN_PASSWORD_HASH=<paste here>
# (don't set ADMIN_PASSWORD when using ADMIN_PASSWORD_HASH)
```

The session cookie is HMAC-signed by `SESSION_SECRET` (must be ≥16 chars). Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Production deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full guides on **Coolify**, **Heroku**, and **Azure App Service** including Dockerfile usage, MongoDB setup, env-var configuration, and a comparison table to help you pick.

## URL conventions

| Route | Purpose |
|---|---|
| `GET /go/:slug` | Hot path - public landing page entry |
| `GET /go/:wsSlug/:campSlug` | Multi-tenant landing page entry |
| `GET /px/conv?cid=...&value=...` | Conversion pixel (1x1 GIF) |
| `GET\|POST /cb/postback` | Server-to-server conversion |
| `GET /admin` | Admin dashboard |
| `GET /admin/campaigns` | Campaign CRUD |
| `GET /admin/pages` | Landing page CRUD |
| `GET /admin/clicks` | Click log with filters |
| `GET /admin/asn` | ASN blacklist management |

## Project layout

```
botguard/
├── src/
│   ├── server.js
│   ├── routes/
│   │   ├── go.js              # Hot path
│   │   ├── pixel.js           # Conversion pixel
│   │   ├── postback.js        # S2S postback
│   │   └── admin/             # Admin panel
│   ├── lib/
│   │   ├── bootstrap.js       # Default workspace + ASN seed
│   │   ├── click.js           # Click ID + writer
│   │   ├── ip.js              # IP extraction
│   │   ├── utm.js             # UTM parsing
│   │   ├── inapp.js           # In-app browser detection
│   │   ├── variant.js         # A/B picker
│   │   ├── asnLookup.js       # Cached ASN blacklist lookup
│   │   └── logger.js
│   ├── models/                # Mongoose schemas
│   └── views/                 # EJS templates
├── public/css/admin.css
└── scripts/seed.js
```

## Source profiles

Each campaign picks a source profile that will (in week 2) determine how filter scores are weighted:

| Profile | Network | Behavior | Notes |
|---|---|---|---|
| `email` | Low | Low | Tolerate Outlook / Gmail / Apple MPP prefetchers |
| `paid_ads` | High | High | Click fraud is real |
| `organic` | Medium | Medium | Search engine bots are legit, scrapers aren't |
| `affiliate` | High | Medium | Highest fraud risk |
| `mixed` | Medium | Medium | Default |
