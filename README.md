# BotGuard v2.1 — Complete Setup Guide

## Part 1: Intelligence Engine Upgrade

Drop-in replacement for 5 files in `src/`. No migration needed — Mongoose adds new fields automatically on next write cycle. See the existing README in previous patches for the 13-signal scoring details.


## Part 2: Cloudflare Edge Firewall Setup

This guide walks you through getting the three values needed for your `.env`:

```
CF_ACCOUNT_ID=
CF_API_TOKEN=
CF_KV_NAMESPACE_ID=
```

---

### Step 1: Get your CF_ACCOUNT_ID

1. Log into https://dash.cloudflare.com
2. Click on your domain (e.g. cookingshow.space)
3. Scroll down on the **Overview** page
4. On the right sidebar, under **API**, you'll see **Account ID**
5. Copy it — it's a 32-character hex string like `023e105f4ecef8ad9ca31a8372d0c353`

That's your `CF_ACCOUNT_ID`.

---

### Step 2: Create CF_API_TOKEN

1. In the Cloudflare dashboard, click your **profile icon** (top right) → **My Profile**
2. Click **API Tokens** in the left sidebar
3. Click **Create Token**
4. Choose **Create Custom Token** (not a template)
5. Set the following:
   - **Token name**: `BotGuard KV Writer`
   - **Permissions**:
     - Account → **Workers KV Storage** → **Edit**
   - **Account Resources**:
     - Include → **Your account name**
   - Leave IP filtering and TTL blank (or set TTL to 1 year)
6. Click **Continue to summary** → **Create Token**
7. **COPY THE TOKEN NOW** — you won't see it again
   - It looks like: `Sn3lZJTBX6kkg7OdcBUAxOO963GEIyGQqnFTOFYY`

That's your `CF_API_TOKEN`.

> **Important**: This token ONLY needs "Workers KV Storage: Edit" permission.
> Don't give it broader access. If it's ever leaked, the attacker can only
> read/write your KV store, not modify your DNS or Workers.

---

### Step 3: Create KV Namespace and get CF_KV_NAMESPACE_ID

1. In the Cloudflare dashboard, go to **Workers & Pages** (left sidebar)
2. Click **KV** in the sub-menu
3. Click **Create a namespace**
4. Name it: `BOTGUARD_BLOCKLIST`
5. Click **Add**
6. The namespace appears in the list — click on it
7. The **Namespace ID** is shown at the top (32-character hex string)
   - Example: `0f2ac74b498b48028cb68387c421e279`

That's your `CF_KV_NAMESPACE_ID`.

---

### Step 4: Add to your .env

```bash
# Cloudflare Edge Firewall
CF_ACCOUNT_ID=023e105f4ecef8ad9ca31a8372d0c353
CF_API_TOKEN=Sn3lZJTBX6kkg7OdcBUAxOO963GEIyGQqnFTOFYY
CF_KV_NAMESPACE_ID=0f2ac74b498b48028cb68387c421e279
```

Restart BotGuard. The `/admin/cloudflare` page will now show the sync button as active.

---

### Step 5: Deploy the Cloudflare Worker

1. In the Cloudflare dashboard, go to **Workers & Pages**
2. Click **Create** → **Create Worker**
3. Name it: `botguard-firewall`
4. Click **Deploy** (deploys the hello-world default)
5. Click **Edit Code**
6. Replace the entire code with the contents of `cloudflare-worker.js` from this package
7. Click **Save and Deploy**

Now bind the KV namespace to the Worker:

8. Go to the Worker's **Settings** → **Bindings**
9. Click **Add binding** → **KV Namespace**
10. Set:
    - **Variable name**: `BLOCKLIST` (must be exactly this)
    - **KV Namespace**: Select `BOTGUARD_BLOCKLIST`
11. Click **Save**

Finally, set up the route so the Worker runs on your domain:

12. Go to the Worker's **Settings** → **Triggers** → **Routes**
13. Click **Add route**
14. Set:
    - **Route**: `cookingshow.space/*` (your domain)
    - **Zone**: Select your domain
15. Click **Save**

---

### Step 6: Test it

1. Go to `/admin/cloudflare` in BotGuard
2. Add a test rule: Type = IP, Value = your own IP, Action = block
3. Click **☁ Push to Cloudflare**
4. Open your site in a new browser tab — you should see a 520 error
5. Go back to BotGuard, delete the test rule, push again
6. Your site loads normally again

---

## How to Use

### Adding rules

**From Intelligence**: Go to `/admin/intelligence`, select blocks with checkboxes, click **☁ Add to Cloudflare**. They appear in `/admin/cloudflare` with source "intelligence".

**From ASN Blacklist**: Go to `/admin/asn`, select ASN rules, click **Export to Cloudflare** (when available). They appear with source "asn_import".

**Manual**: In `/admin/cloudflare`, expand "+ Add rule", fill in the IP/CIDR/ASN.

**CSV Upload**: Expand "↑ Upload CSV", upload a text file with one entry per line:
- IPs: `146.86.149.221`
- CIDRs: `66.207.24.0/24` or `2600:387::/32`
- Wildcards: `66.207.24.*` (auto-converted to `/24`)
- ASNs: `7922`
- Optional CSV format: `value,type,label` (e.g. `66.207.24.0/24,cidr,Muscatine Power`)

### Scan modes

**UTM/Ad clicks only** (default): The Worker only blocks requests that have `utm_source`, `gclid`, `wbraid`, `fbclid`, `msclkid`, or any UTM parameter in the URL. Organic visitors and direct traffic pass through unchecked. Use this when you only want to block bot ad clicks.

**All traffic**: The Worker checks every request. Full edge firewall. Use this when you want to completely deny access to bot IPs.

### Enable / Disable

The green/red toggle at the top of `/admin/cloudflare` enables or disables the entire edge firewall. When disabled, the Worker passes all traffic through. Rules stay saved — just not enforced. Toggling auto-syncs to Cloudflare so the change is instant.

### Syncing

After adding/removing/toggling rules, click **☁ Push to Cloudflare** to sync. This sends the entire ruleset as one KV write (1 of your 1,000/day limit). The "Pending sync" counter shows how many rules have changed since the last push.

---

## File List

```
cloudflare-worker.js              — Deploy to Cloudflare Workers dashboard
src/lib/cloudflareSync.js         — KV push logic
src/lib/cidrAnalyser.js           — v2.1 scoring engine (13 signals)
src/lib/cidrTriggers.js           — 9 trigger types
src/lib/dwellWriteback.js         — Dwell/bounce tracking pipeline
src/lib/livePresence.js           — Modified: computes dwell_ms on leave
src/models/CloudflareRule.js      — Edge firewall rule collection
src/models/CidrIntelligence.js    — Extended with v2.1 fields
src/models/Click.js               — Added dwell_ms field
src/models/Workspace.js           — Added cloudflare_settings
src/models/index.js               — Registers CloudflareRule
src/routes/admin/cloudflare.js    — /admin/cloudflare routes
src/routes/admin/index.js         — Mounts cloudflare routes + intelligence fixes
src/views/admin/cloudflare.ejs    — Cloudflare dashboard UI
src/views/admin/intelligence.ejs  — Added "Add to Cloudflare" button
src/views/admin/_layout.ejs       — Added Cloudflare nav link
src/server.js                     — Starts dwell writeback
v1-backup/                        — Original files for rollback
```
