# Google Ads IP Exclusion Sync

## Overview

Automatically sync BotGuard's CIDR Intelligence with your Google Ads campaigns' IP exclusion lists. A Google Ads Script runs hourly, sends current exclusions to BotGuard, and BotGuard returns optimized add/remove instructions.

```
Google Ads Script (hourly)
    │
    │  POST /api/optimize-exclusions
    │  { campaignName, existingExclusions: [...] }
    │
    ▼
BotGuard Server
    │  Compare against CidrIntelligence (scored threats)
    │  Handle 500-limit FIFO rotation
    │  Aggregate /32 IPs into /24 subnets
    │
    │  Response: { add: [...], remove: [...], stats: {...} }
    │
    ▼
Google Ads Script
    │  Remove stale entries first
    │  Add new threats
    ▼
Campaign protected
```

## Setup

### Step 1: Configure BotGuard

Add to your `.env`:
```bash
GADS_SYNC_KEY=your-random-secret-key-here    # shared auth key
GADS_EXCLUSION_LIMIT=500                      # Google's limit (default 500)
GADS_MIN_SCORE=50                             # minimum intelligence score to export
GADS_RESERVE_SLOTS=50                         # keep 50 slots free for manual entries
```

### Step 2: Deploy the Google Ads Script

1. Open Google Ads → Tools → Scripts → New Script
2. Paste the contents of `scripts/google-ads-sync.js`
3. Edit the configuration at the top:
   - `CAMPAIGN_NAME` — exact name of your display campaign
   - `SERVER_URL` — your BotGuard domain (e.g. `https://cookingshow.space`)
   - `API_KEY` — must match `GADS_SYNC_KEY` in your `.env`
4. Click "Preview" to test (check the log output)
5. Schedule: Hourly

### Step 3: Verify

Check the sync status without applying changes:
```
GET https://yourdomain.com/api/sync-status?key=your-key
```

Returns:
```json
{
  "threats_eligible": 142,
  "min_score": 50,
  "limit": 500,
  "reserve": 50,
  "configured": true
}
```

## How It Works

### First-Time Sync (Empty Campaign)

When a campaign has zero exclusions:
- BotGuard pushes the top threats (by score) up to `LIMIT - RESERVE` (default 450)
- Highest-scoring CIDRs go first
- The `remove` array is empty

### Delta Sync (Existing Exclusions)

On subsequent runs:
- **New threats**: CIDRs in BotGuard's intelligence but not in Google Ads → `add`
- **Stale entries**: CIDRs in Google Ads but no longer in BotGuard (dismissed, archived, score dropped) → `remove`
- If there's room: add all new threats
- If at the limit: FIFO rotation kicks in

### FIFO Rotation (At the 500 Limit)

When the campaign is full:
1. Remove all stale entries first (always)
2. If still not enough room: remove the lowest-scoring existing entries
3. Only evict if the new threat has a higher score than what it replaces
4. Highest-priority threats always win

### CIDR Aggregation

BotGuard rolls up individual IPs into /24 subnets when 3+ IPs share the same /24. This saves exclusion slots:
- Before: `98.109.196.1`, `98.109.196.15`, `98.109.196.200` → 3 slots
- After: `98.109.196.0/24` → 1 slot (covers all 256 IPs in the range)

## API Reference

### POST /api/optimize-exclusions

**Headers**: `x-api-key: your-key` or `?key=your-key`

**Request Body**:
```json
{
  "campaignName": "My Display Campaign",
  "existingExclusions": ["1.2.3.4", "5.6.0.0/24"]
}
```

**Response**:
```json
{
  "add": ["2003:d8::/32", "188.103.46.0/24"],
  "remove": ["1.2.3.4"],
  "stats": {
    "threats_in_database": 142,
    "existing_exclusions": 380,
    "adding": 12,
    "removing": 5,
    "final_count": 387,
    "limit": 500,
    "effective_limit": 450
  }
}
```

### GET /api/sync-status

**Headers**: `x-api-key: your-key`

Returns current threat count and configuration without modifying anything.

## Multiple Campaigns

To sync multiple campaigns, duplicate the Google Ads Script with different `CAMPAIGN_NAME` values. Each campaign gets its own exclusion list independently — BotGuard serves the same threat intelligence to all of them.

## Files

| File | Description |
|---|---|
| `src/routes/gadsSync.js` | Express route: optimization logic + auth |
| `scripts/google-ads-sync.js` | Google Ads Script (paste into Google Ads editor) |
| `src/server.js` | Mounts `/api` route |
