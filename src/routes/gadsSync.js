/**
 * gadsSync.js — Google Ads IP exclusion sync endpoint.
 *
 * Architecture:
 *   Google Ads Script (courier) → POST /api/optimize-exclusions → BotGuard (brains) → {add, remove}
 *
 * The Google Ads Script sends the campaign's current IP exclusions.
 * BotGuard compares against its CidrIntelligence database, computes the
 * optimal delta (what to add, what to remove), and returns clean instructions.
 *
 * Handles:
 *   - Empty list (first-time sync): pushes top threats up to the limit
 *   - Delta sync: adds new threats, removes stale entries
 *   - 500-limit FIFO rotation: when full, removes lowest-score/oldest entries
 *     to make room for higher-priority threats
 *   - CIDR aggregation: rolls up individual /32 IPs into /24 subnets when
 *     3+ IPs share a /24, saving exclusion slots
 *
 * Auth: GADS_SYNC_KEY in .env, passed as x-api-key header or ?key= param
 *
 * ENV:
 *   GADS_SYNC_KEY          — shared secret for auth
 *   GADS_EXCLUSION_LIMIT   — max exclusions per campaign (default 500)
 *   GADS_MIN_SCORE         — minimum intelligence score to export (default 50)
 *   GADS_RESERVE_SLOTS     — slots to keep free for manual entries (default 50)
 */

'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../lib/logger');

const DEFAULT_LIMIT = 500;
const DEFAULT_MIN_SCORE = 50;
const DEFAULT_RESERVE = 50;

// ── Auth middleware ──────────────────────────────────────────────────

function requireSyncKey(req, res, next) {
  const key = process.env.GADS_SYNC_KEY;
  if (!key) return res.status(503).json({ error: 'GADS_SYNC_KEY not configured' });

  const provided = req.headers['x-api-key'] || req.query.key;
  if (!provided || provided !== key) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ── CIDR aggregation helpers ─────────────────────────────────────────

/**
 * Roll up individual IPv4 /32 addresses into /24 subnets when 3+ IPs
 * share the same /24. This saves exclusion slots — one /24 replaces
 * up to 256 individual IPs.
 */
function aggregateCidrs(cidrs) {
  const ipv4Singles = [];  // individual IPs or /32s
  const existing = [];      // already aggregated or IPv6

  for (const cidr of cidrs) {
    if (cidr.includes(':')) {
      // IPv6 — keep as-is (already /32 blocks from intelligence)
      existing.push(cidr);
    } else if (cidr.endsWith('/32') || !cidr.includes('/')) {
      // Single IPv4
      ipv4Singles.push(cidr.replace(/\/32$/, ''));
    } else {
      // Already a subnet (/24, /16, etc.)
      existing.push(cidr);
    }
  }

  // Group singles by their /24 prefix
  const prefixGroups = {};
  for (const ip of ipv4Singles) {
    const parts = ip.split('.');
    if (parts.length !== 4) continue;
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
    if (!prefixGroups[prefix]) prefixGroups[prefix] = [];
    prefixGroups[prefix].push(ip);
  }

  const result = [...existing];
  for (const [prefix, ips] of Object.entries(prefixGroups)) {
    if (ips.length >= 3) {
      // Roll up: 3+ IPs in the same /24 → use the /24
      result.push(`${prefix}.0/24`);
    } else {
      // Keep individual IPs
      for (const ip of ips) result.push(ip);
    }
  }

  return result;
}

// ── Main optimization logic ──────────────────────────────────────────

router.post('/optimize-exclusions', requireSyncKey, async (req, res) => {
  try {
    const { campaignName, existingExclusions = [] } = req.body || {};

    const CidrIntelligence = require('../models/CidrIntelligence');
    const { Workspace } = require('../models');

    const ws = await Workspace.findOne().lean();
    if (!ws) return res.status(404).json({ error: 'No workspace found' });

    // Check if Google Ads sync is enabled
    const gadsSettings = ws.settings?.gads_sync || {};
    if (!gadsSettings.enabled) {
      return res.status(403).json({ error: 'Google Ads sync is disabled. Enable it in Intelligence → Settings.' });
    }

    // Use workspace settings, fall back to env vars, then defaults
    const maxLimit = gadsSettings.exclusion_limit || parseInt(process.env.GADS_EXCLUSION_LIMIT, 10) || DEFAULT_LIMIT;
    const minScore = gadsSettings.min_score || parseInt(process.env.GADS_MIN_SCORE, 10) || DEFAULT_MIN_SCORE;
    const reserveSlots = gadsSettings.reserve_slots || parseInt(process.env.GADS_RESERVE_SLOTS, 10) || DEFAULT_RESERVE;
    const effectiveLimit = maxLimit - reserveSlots; // leave room for manual entries

    // Fetch all active threats from intelligence, sorted by score descending
    const threats = await CidrIntelligence.find({
      workspace_id: ws._id,
      score: { $gte: minScore },
      status: { $nin: ['dismissed', 'archived'] },
    })
      .select('cidr score last_seen hit_count')
      .sort({ score: -1, hit_count: -1 })
      .lean();

    // Build the master threat list (aggregated for slot efficiency)
    const masterCidrs = aggregateCidrs(threats.map(t => t.cidr));
    // Build a score map for priority decisions
    const scoreMap = new Map();
    for (const t of threats) scoreMap.set(t.cidr, t.score);

    // Normalize existing exclusions for comparison
    const existingSet = new Set(existingExclusions.map(e => e.trim()));

    let toAdd = [];
    let toRemove = [];

    if (existingExclusions.length === 0) {
      // ── First-time sync: push top threats up to the limit ──────────
      toAdd = masterCidrs.slice(0, effectiveLimit);

      logger.info('gads_sync_first_time', {
        campaign: campaignName,
        threats_available: masterCidrs.length,
        adding: toAdd.length,
        limit: effectiveLimit,
      });
    } else {
      // ── Delta sync: compare existing vs master ─────────────────────
      const masterSet = new Set(masterCidrs);

      // New threats not yet in Google Ads
      const newThreats = masterCidrs.filter(c => !existingSet.has(c));

      // Stale entries in Google Ads that are no longer in our threat list
      // (score dropped below threshold, dismissed, or archived)
      const staleEntries = existingExclusions.filter(e => !masterSet.has(e.trim()));

      // Calculate how many slots are available after removing stale entries
      const currentCount = existingExclusions.length;
      const afterRemoval = currentCount - staleEntries.length;
      const slotsAvailable = effectiveLimit - afterRemoval;

      if (slotsAvailable >= newThreats.length) {
        // Plenty of room — add all new threats, remove all stale
        toAdd = newThreats;
        toRemove = staleEntries;
      } else if (slotsAvailable > 0) {
        // Some room — add what fits (highest score first), remove stale
        toAdd = newThreats.slice(0, slotsAvailable);
        toRemove = staleEntries;
      } else {
        // ── FIFO rotation: at the limit, need to make room ───────────
        // Remove the lowest-scoring existing entries to make room for
        // higher-scoring new threats.

        // Score the existing entries
        const existingScored = existingExclusions.map(e => ({
          cidr: e.trim(),
          score: scoreMap.get(e.trim()) || 0,
        })).sort((a, b) => a.score - b.score); // lowest score first

        // Always remove stale entries
        toRemove = [...staleEntries];
        let freed = staleEntries.length;

        // If we still need more room, remove lowest-scoring existing entries
        // but only if the new threats have higher scores
        const minNewScore = newThreats.length > 0
          ? (scoreMap.get(newThreats[0]) || minScore)
          : 0;

        for (const entry of existingScored) {
          if (freed >= newThreats.length) break;
          // Only evict if the new threat is higher priority
          if (entry.score < minNewScore && !staleEntries.includes(entry.cidr)) {
            toRemove.push(entry.cidr);
            freed++;
          }
        }

        toAdd = newThreats.slice(0, freed);
      }

      logger.info('gads_sync_delta', {
        campaign: campaignName,
        existing: currentCount,
        threats_available: masterCidrs.length,
        stale_removed: staleEntries.length,
        adding: toAdd.length,
        removing: toRemove.length,
        final_count: currentCount - toRemove.length + toAdd.length,
      });
    }

    // Deduplicate
    toAdd = [...new Set(toAdd)];
    toRemove = [...new Set(toRemove)];

    // Final safety check: don't exceed limit
    const finalCount = existingExclusions.length - toRemove.length + toAdd.length;
    if (finalCount > maxLimit) {
      toAdd = toAdd.slice(0, maxLimit - (existingExclusions.length - toRemove.length));
    }

    // Mark CIDRs in intelligence database
    // toAdd → gads_exported: true (now active in Google Ads)
    if (toAdd.length > 0) {
      await CidrIntelligence.updateMany(
        { workspace_id: ws._id, cidr: { $in: toAdd } },
        { $set: { gads_exported: true, gads_exported_at: new Date() } }
      );
    }
    // toRemove → gads_exported: false (removed from Google Ads)
    if (toRemove.length > 0) {
      await CidrIntelligence.updateMany(
        { workspace_id: ws._id, cidr: { $in: toRemove } },
        { $set: { gads_exported: false, gads_exported_at: null } }
      );
    }

    // Update last sync stats on workspace
    try {
      await Workspace.updateOne({ _id: ws._id }, { $set: {
        'settings.gads_sync.last_sync_at': new Date(),
        'settings.gads_sync.last_sync_added': toAdd.length,
        'settings.gads_sync.last_sync_removed': toRemove.length,
      }});
    } catch (e) {}

    res.json({
      add: toAdd,
      remove: toRemove,
      stats: {
        threats_in_database: threats.length,
        existing_exclusions: existingExclusions.length,
        adding: toAdd.length,
        removing: toRemove.length,
        final_count: existingExclusions.length - toRemove.length + toAdd.length,
        limit: maxLimit,
        effective_limit: effectiveLimit,
      },
    });

  } catch (err) {
    logger.error('gads_sync_error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Status endpoint (GET) — check what would sync without applying ───

router.get('/sync-status', requireSyncKey, async (req, res) => {
  try {
    const CidrIntelligence = require('../models/CidrIntelligence');
    const { Workspace } = require('../models');
    const ws = await Workspace.findOne().lean();
    if (!ws) return res.status(404).json({ error: 'No workspace' });

    const gadsSettings = ws.settings?.gads_sync || {};
    const minScore = gadsSettings.min_score || parseInt(process.env.GADS_MIN_SCORE, 10) || DEFAULT_MIN_SCORE;
    const count = await CidrIntelligence.countDocuments({
      workspace_id: ws._id,
      score: { $gte: minScore },
      status: { $nin: ['dismissed', 'archived'] },
    });

    res.json({
      enabled: !!gadsSettings.enabled,
      threats_eligible: count,
      min_score: minScore,
      limit: gadsSettings.exclusion_limit || DEFAULT_LIMIT,
      reserve: gadsSettings.reserve_slots || DEFAULT_RESERVE,
      last_sync_at: gadsSettings.last_sync_at || null,
      last_sync_added: gadsSettings.last_sync_added || 0,
      last_sync_removed: gadsSettings.last_sync_removed || 0,
      api_key_configured: !!process.env.GADS_SYNC_KEY,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
