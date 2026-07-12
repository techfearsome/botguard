/**
 * syncImport.js — pull an import partner's feed, classify each entry against
 * our own data, stage it, and (only where the partner's rules allow) implement
 * it into CidrIntelligence / AsnBlacklist tagged by source.
 *
 * All the trust logic lives in syncMatch.js (pure + tested). This file is the
 * I/O around it: fetch, DB lookups, staging upserts, implementation.
 */

'use strict';

const logger = require('./logger');
const { classifyMatch, decideEntryFate, batchMatchRatio } = require('./syncMatch');

// Node 18+ has global fetch. Kept behind a helper so tests can inject one.
async function defaultFetch(url, opts) {
  return fetch(url, opts);
}

/**
 * Look up local knowledge for a batch of CIDRs in one query.
 * Returns Map<cidr, { known, active, score, hits }>.
 */
async function loadLocalCidr(models, wsId, cidrs) {
  const { CidrIntelligence } = models;
  const map = new Map();
  if (!cidrs.length) return map;
  const docs = await CidrIntelligence.find({
    workspace_id: wsId,
    cidr: { $in: cidrs },
  }).select('cidr score hit_count status').lean();
  for (const d of docs) {
    // "active" = already enforced/blocked locally, so re-adding is pointless.
    const active = d.status === 'blocked' || d.status === 'exported';
    map.set(d.cidr, { known: true, active, score: d.score || 0, hits: d.hit_count || 0 });
  }
  return map;
}

async function loadLocalAsn(models, wsId, asns) {
  const { AsnBlacklist } = models;
  const map = new Map();
  if (!asns.length) return map;
  const nums = asns.map(Number).filter((n) => Number.isFinite(n));
  const docs = await AsnBlacklist.find({
    workspace_id: wsId,
    asn: { $in: nums },
  }).select('asn active').lean();
  for (const d of docs) {
    map.set(String(d.asn), { known: true, active: !!d.active, score: 0, hits: 0 });
  }
  return map;
}

/**
 * Pull + process one import partner.
 * @param {object} deps { models, fetchImpl?, cidrSeed? }
 * @param {object} ws    workspace (needs _id)
 * @param {object} partner  SyncPartner (import), a live mongoose doc
 * @returns {object} stats
 */
async function pullPartner(deps, ws, partner) {
  const models = deps.models;
  const fetchImpl = deps.fetchImpl || defaultFetch;
  const { SyncStagedEntry } = models;

  const stats = { pulled: 0, matched: 0, new_entries: 0, staged: 0, implemented: 0, skipped: 0, error: '' };

  // ── Fetch the feed ────────────────────────────────────────────────
  let payload;
  try {
    const url = new URL(partner.feed_url);
    // Send passcode as a header (avoids logging in query strings on the remote).
    const resp = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { 'x-sync-key': partner.passcode, 'accept': 'application/json' },
    });
    if (!resp.ok) throw new Error(`feed_http_${resp.status}`);
    payload = await resp.json();
    if (!payload || payload.ok === false) throw new Error('feed_rejected');
  } catch (e) {
    stats.error = e.message;
    logger.warn('sync_pull_fetch_failed', { partner: partner.name, err: e.message });
    await recordPull(partner, stats);
    return stats;
  }

  const incomingCidr = partner.pull?.cidr && Array.isArray(payload.cidr) ? payload.cidr : [];
  const incomingAsn = partner.pull?.asn && Array.isArray(payload.asn) ? payload.asn : [];

  // ── Classify against local data ───────────────────────────────────
  const localCidr = await loadLocalCidr(models, ws._id, incomingCidr.map((c) => c.cidr).filter(Boolean));
  const localAsn = await loadLocalAsn(models, ws._id, incomingAsn.map((a) => String(a.asn)).filter(Boolean));

  const classifiedCidr = incomingCidr
    .filter((c) => c && c.cidr)
    .map((c) => ({ raw: c, kind: 'cidr', value: c.cidr, m: classifyMatch(c, localCidr.get(c.cidr) || {}) }));
  const classifiedAsn = incomingAsn
    .filter((a) => a && (a.asn || a.asn === 0))
    .map((a) => ({ raw: a, kind: 'asn', value: String(a.asn), m: classifyMatch(a, localAsn.get(String(a.asn)) || {}) }));

  const all = [...classifiedCidr, ...classifiedAsn];
  stats.pulled = all.length;

  // Percentage-mode batch trust is computed once across the whole pull.
  const batch = batchMatchRatio(all.map((x) => x.m), partner.thresholds?.match_percentage);
  const ctx = { batchTrusted: batch.trusted };

  // ── Stage + implement each entry ──────────────────────────────────
  const toImplementCidr = [];
  const toImplementAsn = [];

  for (const item of all) {
    if (item.m.match_status === 'match') stats.matched++;
    else if (item.m.match_status === 'new') stats.new_entries++;

    const fate = decideEntryFate(partner, item.m, ctx);

    if (fate === 'ignore') {
      // Already active locally — record as duplicate/ignored for visibility, skip.
      stats.skipped++;
      await upsertStaged(SyncStagedEntry, ws, partner, item, 'ignored');
      continue;
    }

    if (fate === 'implement') {
      await upsertStaged(SyncStagedEntry, ws, partner, item, 'implemented');
      if (item.kind === 'cidr') toImplementCidr.push(item);
      else toImplementAsn.push(item);
      stats.implemented++;
    } else {
      await upsertStaged(SyncStagedEntry, ws, partner, item, 'staged');
      stats.staged++;
    }
  }

  // ── Write implemented entries into live pipelines, source-tagged ──
  if (toImplementCidr.length) {
    await implementCidr(deps, ws, partner, toImplementCidr);
  }
  if (toImplementAsn.length) {
    await implementAsn(models, ws, partner, toImplementAsn);
  }

  partner.import_count = (partner.import_count || 0) + 1;
  partner.last_imported_at = new Date();
  await recordPull(partner, stats);

  logger.info('sync_pull_done', {
    partner: partner.name, pulled: stats.pulled, matched: stats.matched,
    implemented: stats.implemented, staged: stats.staged, skipped: stats.skipped,
    batch_ratio: Math.round(batch.ratio),
  });
  return stats;
}

async function upsertStaged(SyncStagedEntry, ws, partner, item, state) {
  const now = new Date();
  await SyncStagedEntry.updateOne(
    { workspace_id: ws._id, source_partner_id: partner._id, kind: item.kind, value: item.value },
    {
      $set: {
        source_name: partner.name,
        asn_org: item.raw.asn_org || '',
        country: item.raw.country || '',
        remote_score: item.raw.score || 0,
        remote_label: item.raw.label || '',
        match_status: item.m.match_status,
        local_score: item.m.local_score,
        local_hits: item.m.local_hits,
        state,
        disposition: partner.disposition,
        last_seen_at: now,
        ...(state === 'implemented' ? { implemented_at: now } : {}),
      },
      $setOnInsert: { first_seen_at: now },
    },
    { upsert: true }
  );
}

// Implement CIDRs by seeding into CidrIntelligence (reuses the existing seed
// pipeline so they flow through block/export machinery), tagged by source.
async function implementCidr(deps, ws, partner, items) {
  const seedSource = `sync:${partner.name}`.slice(0, 100);
  try {
    const cidrSeed = deps.cidrSeed || require('./cidrSeed');
    const values = items.map((i) => i.value);
    await cidrSeed.importSeeds(ws._id, values, { seedSource });
  } catch (e) {
    logger.warn('sync_implement_cidr_failed', { partner: partner.name, err: e.message });
  }
}

// Implement ASNs into AsnBlacklist, tagged by source, deduped by unique index.
async function implementAsn(models, ws, partner, items) {
  const { AsnBlacklist } = models;
  const source = `sync:${partner.name}`.slice(0, 100);
  for (const item of items) {
    const asn = Number(item.value);
    if (!Number.isFinite(asn)) continue;
    try {
      await AsnBlacklist.updateOne(
        { workspace_id: ws._id, asn },
        {
          $setOnInsert: {
            workspace_id: ws._id, asn,
            asn_org: item.raw.asn_org || '',
            category: item.raw.category || 'other',
            severity: item.raw.severity || 'high',
            override: 'mark_proxy',
            active: partner.implement_target === 'direct', // 'seed' stages inactive; 'direct' activates
            source,
          },
        },
        { upsert: true }
      );
    } catch (e) {
      // Unique-index collisions are fine (already have the ASN).
      if (!/E11000/.test(e.message)) {
        logger.warn('sync_implement_asn_failed', { partner: partner.name, asn, err: e.message });
      }
    }
  }
}

async function recordPull(partner, stats) {
  partner.last_pull = {
    at: new Date(),
    pulled: stats.pulled,
    matched: stats.matched,
    new_entries: stats.new_entries,
    staged: stats.staged,
    implemented: stats.implemented,
    skipped: stats.skipped,
    error: stats.error || '',
  };
  try { await partner.save(); } catch (e) { logger.warn('sync_pull_save_failed', { err: e.message }); }
}

/**
 * Scheduler entrypoint: run all import partners across all workspaces whose
 * interval schedule is due. Called on a timer from the analyser loop.
 */
async function runDuePulls(models) {
  const { SyncPartner, Workspace } = models;
  const now = Date.now();
  const partners = await SyncPartner.find({ direction: 'import', enabled: true, 'schedule.mode': 'interval' });
  let ran = 0;
  for (const partner of partners) {
    const intervalMs = Math.max(5, partner.schedule?.interval_minutes || 1440) * 60 * 1000;
    const last = partner.last_imported_at ? new Date(partner.last_imported_at).getTime() : 0;
    if (now - last < intervalMs) continue;
    const ws = await Workspace.findById(partner.workspace_id).lean();
    if (!ws) continue;
    try {
      await pullPartner({ models }, ws, partner);
      ran++;
    } catch (e) {
      logger.warn('sync_scheduled_pull_error', { partner: partner.name, err: e.message });
    }
  }
  if (ran > 0) logger.info('sync_scheduled_pulls', { ran });
  return ran;
}

module.exports = { pullPartner, runDuePulls, loadLocalCidr, loadLocalAsn };
