# Residential Proxy Detection (Layer 2)

## Overview

BotGuard uses ProxyCheck.io as Layer 1 for proxy/VPN detection. Layer 2 adds **residential proxy detection** — catching proxies that route through real ISP connections (IPRoyal, 922Proxy, Bright Data, Oxylabs, etc.) which ProxyCheck often misses because the underlying IP belongs to a legitimate residential ISP.

Three providers are supported. Choose one or let BotGuard auto-select:

| Provider | ENV Variable | Cost per lookup | Residential Proxy | VPN | Confidence Score | Provider Attribution |
|---|---|---|---|---|---|---|
| **ipgeolocation.io** | `IPGEO_API_KEY` | 2 credits | ✅ `is_residential_proxy` | ✅ | ✅ 0-100 | ✅ provider names |
| **Spur** | `SPUR_API_TOKEN` | 1 query | ✅ `client.proxies` | ✅ `tunnels` | — | ✅ operator names |
| **ipinfo.io** | `IPINFO_TOKEN` | 1 request | ✅ separate endpoint | ✅ | ✅ `percent_days_seen` | ✅ service name |


## Setup

### Step 1: Get an API key

Pick one (or more) providers:

**ipgeolocation.io:**
1. Sign up at https://ipgeolocation.io
2. Choose a plan with IP Security API access
3. Copy your API key from the dashboard

**Spur:**
1. Sign up at https://app.spur.us
2. Purchase a Context API subscription
3. Copy your API token from Settings → API

**ipinfo.io:**
1. Sign up at https://ipinfo.io
2. Choose a plan with Privacy Detection + Residential Proxy Detection
3. Copy your token from the dashboard

### Step 2: Add to .env

```bash
# Set whichever providers you have (one or more)
IPGEO_API_KEY=your_ipgeolocation_api_key
SPUR_API_TOKEN=your_spur_token
IPINFO_TOKEN=your_ipinfo_token
```

### Step 3: Enable per campaign

1. Go to `/admin/campaigns`
2. Edit a campaign
3. In the "Residential Proxy Detection (Layer 2)" section:
   - Check "Enable residential proxy detection"
   - Select a provider (or leave as "Auto")
4. Save

**Auto mode** picks the first configured provider in order: ipgeolocation → Spur → ipinfo.


## How It Works

```
Click arrives
    ↓
ProxyCheck.io (Layer 1) — catches datacenter proxies, public VPNs
    ↓ not caught
Campaign has Layer 2 enabled?
    ↓ yes
Provider configured (API key set)?
    ↓ yes
Check in-memory cache (2000 entries) → hit? → use cached
    ↓ miss
Check MongoDB cache (TTL-based) → hit? → use cached
    ↓ miss
Call provider API (5s timeout)
    ↓
is_residential_proxy: true → score +80, HARD BLOCK → safe page
is_vpn: true (not caught by L1) → score +60
is_proxy: true → score +70
    ↓
Result cached:
  - Clean IPs: 24 hours
  - Flagged IPs: 6 hours (residential proxies rotate fast)
```

### Why two layers?

ProxyCheck is fast and cheap but relies on datacenter IP lists and known VPN exit nodes. Residential proxies use real ISP IPs that aren't in those lists. The Layer 2 providers use different detection methods:

- **ipgeolocation.io**: Honeypots + threat feeds + daily database refresh
- **Spur**: Network behavior analysis + proxy provider SDK monitoring
- **ipinfo.io**: Persistent monitoring + percent-days-seen scoring

### Cost control

- Only runs on clicks that **pass** ProxyCheck (no double-spending)
- Only runs on campaigns that **enable** it (not site-wide)
- Two-level cache prevents repeat API calls for the same IP
- 24h cache on clean IPs, 6h on flagged (residential proxies rotate)
- API timeout at 5s — if the provider is slow, the click passes through


## Architecture

```
src/lib/providers/
├── index.js           — Provider router: selects adapter, manages cache
├── ipgeolocation.js   — ipgeolocation.io /v3/security adapter
├── spur.js            — Spur /v2/context adapter
└── ipinfo.js          — ipinfo.io /privacy + /residential_proxy adapter

src/filters/residentialProxy.js — Filter: gates + scoring + flag generation
src/lib/ipgeoSecurity.js        — Legacy standalone client (still works)
src/models/IpgeoCache.js        — MongoDB cache with TTL + provider tracking
src/scoring/decide.js            — 'residential_proxy' added to hard-block flags
```

### Normalized Result Format

All three providers return different JSON structures. The provider adapters normalize them to a unified format:

```javascript
{
  provider: 'ipgeolocation' | 'spur' | 'ipinfo',
  is_residential_proxy: boolean,
  is_vpn: boolean,
  is_proxy: boolean,
  is_tor: boolean,
  is_relay: boolean,
  is_hosting: boolean,
  is_bot: boolean,
  threat_score: number,           // 0-100
  proxy_provider_names: string[], // ['IPRoyal', '922Proxy']
  vpn_provider_names: string[],   // ['NordVPN', 'ProtonVPN']
  confidence: number,             // 0-100
  last_seen: string,              // ISO date or empty
  raw: object,                    // original provider response
}
```


## Files

| File | Action | Description |
|---|---|---|
| `src/lib/providers/index.js` | **NEW** | Provider router + cache layer |
| `src/lib/providers/ipgeolocation.js` | **NEW** | ipgeolocation.io adapter |
| `src/lib/providers/spur.js` | **NEW** | Spur Context API adapter |
| `src/lib/providers/ipinfo.js` | **NEW** | ipinfo.io adapter |
| `src/lib/ipgeoSecurity.js` | existing | Legacy client (still functional) |
| `src/filters/residentialProxy.js` | **UPDATED** | Uses provider router now |
| `src/models/IpgeoCache.js` | **UPDATED** | Added `provider` + `cached_result` |
| `src/models/Campaign.js` | **UPDATED** | Added `residential_proxy: { enabled, provider }` |
| `src/models/index.js` | **UPDATED** | Registers IpgeoCache |
| `src/scoring/decide.js` | **UPDATED** | `residential_proxy` in hard-block |
| `src/lib/filterChain.js` | **UPDATED** | Added residential filter layer |
| `src/routes/go.js` | **UPDATED** | Stores ipgeo_security on Click |
| `src/routes/admin/index.js` | **UPDATED** | Campaign create/update handles new fields |
| `src/views/admin/campaign_form.ejs` | **UPDATED** | Provider selection dropdown |
