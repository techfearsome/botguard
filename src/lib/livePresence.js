/**
 * Live presence tracking.
 *
 * Maintains an in-memory map of currently-active visitors keyed by click_id.
 * Visitors send heartbeats every 10s; we mark them "left" if no heartbeat in 30s.
 *
 * Admin dashboards subscribe via SSE to receive presence events in real time.
 *
 * Design choices:
 *   - In-memory only. Live presence is ephemeral by definition — if the server
 *     restarts, the dashboard rebuilds within 10s as visitors heartbeat again.
 *   - No Redis dependency. ~200 bytes/visitor × 500 concurrent = 100 KB, fine.
 *   - Sweep loop every 5s removes stale visitors and emits "left" events.
 *   - Cap on number of tracked visitors (default 5000) to bound memory in the
 *     unlikely case of a runaway flood.
 *
 * Daily counters:
 *   - We keep a `conversionsToday` counter that resets at midnight (server TZ).
 *   - It's seeded from the DB (Conversion collection) on first dashboard load
 *     so it's accurate even after a server restart mid-day.
 *   - On each `converted()` call, the counter is incremented and a `daily_stats`
 *     event is emitted so admin dashboards can update without polling.
 *   - Date-rollover is handled lazily: every counter access checks if the day
 *     has changed and resets if so. This avoids needing a separate timer.
 */

const { EventEmitter } = require('events');

const STALE_AFTER_MS = 30 * 1000;       // 30s without heartbeat = visitor left
const SWEEP_INTERVAL_MS = 5 * 1000;     // check for stale visitors every 5s
const MAX_TRACKED = 5000;                // memory cap
const MAX_HEARTBEAT_BODY = 1024;         // input validation

/**
 * Returns YYYY-MM-DD for the given Date in the server's local TZ.
 * We use this as the "day key" — when it changes, daily counters reset.
 */
function dayKey(d = new Date()) {
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

class LivePresence extends EventEmitter {
  constructor() {
    super();
    // Map<click_id, VisitorRecord>
    this.visitors = new Map();
    // Per-workspace daily counters: Map<workspaceId, { day, conversions }>
    // We key by workspace so multi-tenant deployments report accurately.
    // The 'global' bucket aggregates all workspaces (for snapshot()-without-ws).
    this.dailyByWorkspace = new Map();
    this.startedAt = Date.now();

    this.sweepInterval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepInterval.unref?.();        // don't block Node from exiting in tests
  }

  /**
   * Get or create the daily-counter bucket for a workspace, auto-resetting if
   * the day has changed since last access. Centralizing this in one helper
   * means every counter read/write is rollover-safe without a timer.
   *
   * @param {string} workspaceId - workspace ID, or 'global' for cross-workspace
   * @returns {{day: string, conversions: number, justRolled: boolean}}
   */
  _getDailyBucket(workspaceId) {
    const wsKey = String(workspaceId || 'global');
    const today = dayKey();
    let bucket = this.dailyByWorkspace.get(wsKey);
    let justRolled = false;
    if (!bucket || bucket.day !== today) {
      // Day rolled over (or first access). Emit daily_stats reset before
      // overwriting so subscribers see the rollover.
      const wasNonZero = bucket && bucket.conversions > 0;
      bucket = { day: today, conversions: 0, seeded: false };
      this.dailyByWorkspace.set(wsKey, bucket);
      if (wasNonZero) justRolled = true;
    }
    bucket.justRolled = justRolled;
    return bucket;
  }

  /**
   * Seed the daily conversion counter from the database. Called when an admin
   * loads /admin/live - if the counter hasn't been seeded today, we count
   * Conversion records since 00:00 server-local-time and stash that.
   *
   * Future converted() calls will increment from there.
   *
   * @param {string} workspaceId
   * @param {object} ConversionModel - the mongoose Conversion model
   */
  async seedDailyFromDb(workspaceId, ConversionModel) {
    if (!ConversionModel) return;
    const bucket = this._getDailyBucket(workspaceId);
    if (bucket.seeded) return bucket;
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);    // midnight server-local
      const filter = {
        ts: { $gte: start },
      };
      if (workspaceId && workspaceId !== 'global') {
        filter.workspace_id = workspaceId;
      }
      const count = await ConversionModel.countDocuments(filter);
      bucket.conversions = count;
      bucket.seeded = true;
    } catch (err) {
      // Seeding is best-effort - don't break dashboard load if Mongo hiccups
      bucket.seeded = true;
    }
    return bucket;
  }

  /**
   * Called when /go assigns a click_id. Records the visitor's metadata so
   * the dashboard has rich info before the first heartbeat fires.
   *
   * @param {object} entry
   * @param {string} entry.click_id - required
   * @param {string} [entry.workspace_id]
   * @param {string} [entry.campaign_id]
   * @param {string} [entry.campaign_name]
   * @param {string} [entry.campaign_slug]
   * @param {string} [entry.page_type] - 'offer' | 'safe'
   * @param {string} [entry.ip]
   * @param {string} [entry.country]
   * @param {string} [entry.country_name]
   * @param {string} [entry.asn_org]
   * @param {boolean} [entry.is_proxy]
   * @param {string} [entry.proxy_type]
   * @param {string} [entry.ip_type]
   * @param {string} [entry.device_label]
   * @param {string} [entry.in_app_browser]
   * @param {object} [entry.utm]
   * @param {string} [entry.decision]
   */
  arrived(entry) {
    if (!entry || !entry.click_id) return;
    if (this.visitors.size >= MAX_TRACKED && !this.visitors.has(entry.click_id)) {
      // At cap - drop oldest visitor to make room
      const oldestKey = this.visitors.keys().next().value;
      if (oldestKey) this.visitors.delete(oldestKey);
    }
    const now = Date.now();
    const existing = this.visitors.get(entry.click_id);
    const record = {
      click_id: entry.click_id,
      workspace_id: entry.workspace_id || null,
      campaign_id: entry.campaign_id || null,
      campaign_name: entry.campaign_name || null,
      campaign_slug: entry.campaign_slug || null,
      page_type: entry.page_type || 'unknown',
      ip: entry.ip || null,
      country: entry.country || null,
      country_name: entry.country_name || null,
      asn_org: entry.asn_org || null,
      is_proxy: !!entry.is_proxy,
      proxy_type: entry.proxy_type || null,
      ip_type: entry.ip_type || null,
      device_label: entry.device_label || null,
      in_app_browser: entry.in_app_browser || null,
      utm: entry.utm || {},
      decision: entry.decision || null,
      arrived_at: existing ? existing.arrived_at : now,
      last_seen_at: now,
      converted: existing ? existing.converted : false,
      converted_at: existing ? existing.converted_at : null,
      conversion_term: existing ? existing.conversion_term : null,
      conversion_text: existing ? existing.conversion_text : null,
      conversion_href: existing ? existing.conversion_href : null,
    };
    this.visitors.set(entry.click_id, record);
    this.emit('event', { type: existing ? 'updated' : 'arrived', visitor: record });
  }

  /**
   * Heartbeat from visitor's browser. Just bumps last_seen_at.
   */
  heartbeat(clickId) {
    if (!clickId || typeof clickId !== 'string' || clickId.length > 64) return false;
    const v = this.visitors.get(clickId);
    if (!v) return false;
    v.last_seen_at = Date.now();
    this.emit('event', { type: 'heartbeat', visitor: v });
    return true;
  }

  /**
   * Visitor explicitly left (page unload). Removes immediately.
   */
  left(clickId) {
    if (!clickId || typeof clickId !== 'string') return false;
    const v = this.visitors.get(clickId);
    if (!v) return false;
    this.visitors.delete(clickId);
    this.emit('event', {
      type: 'left',
      visitor: { ...v, left_at: Date.now() },
    });
    return true;
  }

  /**
   * Visitor converted - mark them but don't remove (they may still be on page).
   * Called from /cb/auto-conv when a conversion fires.
   *
   * Also bumps the per-workspace daily conversion counter and emits a
   * `daily_stats` event so admin dashboards update their "Conversions today"
   * card without polling.
   */
  converted({ click_id, term, text, href, workspace_id }) {
    if (!click_id) return;

    // Determine the workspace for daily-counter purposes. Prefer the explicit
    // arg; fall back to the visitor's recorded workspace if we have one tracked.
    const v = this.visitors.get(click_id);
    const wsId = workspace_id || (v && v.workspace_id) || null;

    // Bump per-workspace counter (if workspace known) AND the global one.
    // The global bucket is what cross-workspace admin dashboards listen to.
    if (wsId) {
      const wsBucket = this._getDailyBucket(wsId);
      wsBucket.conversions += 1;
      this.emit('daily_stats', {
        workspace_id: String(wsId),
        day: wsBucket.day,
        conversions_today: wsBucket.conversions,
      });
    }
    const globalBucket = this._getDailyBucket('global');
    globalBucket.conversions += 1;
    this.emit('daily_stats', {
      workspace_id: 'global',
      day: globalBucket.day,
      conversions_today: globalBucket.conversions,
    });

    if (!v) return;       // visitor not currently tracked, only counters bumped
    v.converted = true;
    v.converted_at = Date.now();
    v.conversion_term = term || null;
    v.conversion_text = text || null;
    v.conversion_href = href || null;
    v.last_seen_at = Date.now();
    this.emit('event', { type: 'converted', visitor: v });
  }

  /**
   * Periodic sweep - removes visitors whose last heartbeat is too old.
   */
  sweep() {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [clickId, v] of this.visitors) {
      if (v.last_seen_at < cutoff) {
        this.visitors.delete(clickId);
        this.emit('event', {
          type: 'left',
          visitor: { ...v, left_at: Date.now(), reason: 'stale' },
        });
      }
    }
  }

  /**
   * Snapshot of current state for the dashboard's initial load.
   * Filtered by workspace_id if provided.
   */
  /**
   * Snapshot of current state for the dashboard's initial load.
   * Filtered by workspace_id if provided.
   *
   * Includes `conversions_today` (rolls over at midnight). The caller should
   * have already invoked `seedDailyFromDb(workspaceId, Conversion)` to make
   * sure the counter reflects DB state, not just in-process activity.
   */
  snapshot(workspaceId) {
    const visitors = [];
    let onOffer = 0, onSafe = 0, converted = 0;
    for (const v of this.visitors.values()) {
      if (workspaceId && v.workspace_id && String(v.workspace_id) !== String(workspaceId)) continue;
      visitors.push(v);
      if (v.page_type === 'offer') onOffer += 1;
      else if (v.page_type === 'safe') onSafe += 1;
      if (v.converted) converted += 1;
    }
    visitors.sort((a, b) => b.arrived_at - a.arrived_at);

    // Read daily counter (auto-resets if day rolled over)
    const bucket = this._getDailyBucket(workspaceId || 'global');

    return {
      active: visitors.length,
      on_offer: onOffer,
      on_safe: onSafe,
      converted_now: converted,                    // currently-visible converts
      conversions_today: bucket.conversions,       // rolling daily count
      day: bucket.day,
      visitors,
    };
  }

  /**
   * For tests / shutdown - stop the sweep timer
   */
  stop() {
    if (this.sweepInterval) clearInterval(this.sweepInterval);
    this.sweepInterval = null;
  }
}

// Singleton instance shared across the process
const live = new LivePresence();

module.exports = { live, LivePresence, STALE_AFTER_MS, SWEEP_INTERVAL_MS, MAX_TRACKED };
