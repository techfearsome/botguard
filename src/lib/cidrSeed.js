/**
 * Seed importer for CIDR snapshot baseline.
 *
 * Takes external sources of known-bad CIDRs (existing Google Ads exclusion
 * lists, AbuseIPDB-style block lists, curated firewall CSVs) and creates
 * CidrDailySnapshot entries so the system has historical memory from the
 * moment it deploys.
 *
 * Each seeded snapshot is marked source='seed' with a `seed_source` tag
 * recording where it came from. The analyser uses this to set
 * `historical_match.is_seeded` on CidrIntelligence records.
 *
 * Input formats supported:
 *   1. Plain CIDR / wildcard, one per line:
 *      1.2.3.0/24
 *      4.5.6.*
 *      2600:387::/32
 *      # comments and blank lines OK
 *   2. CSV with columns containing the CIDR (auto-detects column).
 *
 * Normalisation:
 *   - IPv4 wildcards (1.2.3.*) → CIDR (1.2.3.0/24)
 *   - IPv4 with full /32 host bits → /24
 *   - IPv6 with anything other than first 32 bits → /32
 *   - IPv6 hextets with leading zeros stripped (0387 → 387)
 *
 * Seed date defaults to 30 days ago so seeds count as historical evidence
 * but don't appear in today/yesterday snapshot views.
 */

'use strict';

const logger = require('./logger');

function getModels() {
  const { CidrDailySnapshot } = require('../models');
  return { CidrDailySnapshot };
}

/**
 * Convert one line of input into a normalised CIDR string, or null.
 */
function normaliseCidr(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith(';')) return null;

  // Strip inline comments
  const noComment = line.replace(/\s+#.*$/, '').trim();

  // IPv6 → /32
  if (noComment.includes(':')) {
    // Strip leading zeros within hextets so 0387 → 387, 0000 → 0
    const stripZeros = (h) => h.replace(/^0+/, '') || '0';

    if (noComment.includes('/')) {
      const [addr, prefix] = noComment.split('/');
      const p = parseInt(prefix, 10);
      if (isNaN(p)) return null;
      const parts = addr.split(':');
      const truncated = parts.slice(0, 2).map(x => stripZeros(x || '0')).join(':');
      return `${truncated}::/32`;
    }
    const parts = noComment.split(':');
    const truncated = parts.slice(0, 2).map(x => stripZeros(x || '0')).join(':');
    return `${truncated}::/32`;
  }

  // IPv4 wildcard (1.2.3.*) → /24
  if (noComment.endsWith('.*')) {
    const base = noComment.slice(0, -2);
    const octets = base.split('.');
    if (octets.length !== 3) return null;
    if (!octets.every(o => /^\d+$/.test(o) && +o >= 0 && +o < 256)) return null;
    return `${base}.0/24`;
  }

  // IPv4 CIDR
  if (noComment.includes('/')) {
    const [addr, prefix] = noComment.split('/');
    const octets = addr.split('.');
    if (octets.length !== 4) return null;
    if (!octets.every(o => /^\d+$/.test(o) && +o >= 0 && +o < 256)) return null;
    const p = parseInt(prefix, 10);
    if (isNaN(p) || p < 0 || p > 32) return null;
    // Reduce to /24 - truncate fourth octet
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  // Bare IPv4 - assume /24
  const octets = noComment.split('.');
  if (octets.length === 4 && octets.every(o => /^\d+$/.test(o) && +o >= 0 && +o < 256)) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  return null;
}

function getIpVersion(cidr) {
  return cidr.includes(':') ? 'v6' : 'v4';
}

/**
 * Parse a text body (plain list OR CSV) into a list of normalised CIDRs.
 *
 * @param {string} text
 * @returns {{ valid: string[], invalid: string[] }}
 */
function parseText(text) {
  if (!text || typeof text !== 'string') return { valid: [], invalid: [] };

  const valid = new Set();
  const invalid = [];
  const lines = text.split(/\r?\n/);

  // Detect if it's CSV (first non-comment line has at least 2 commas-separated fields)
  // We try CSV parsing first; if no column yields valid CIDRs, fall through to plain.
  const firstDataLine = lines.find(l => l.trim() && !l.trim().startsWith('#'));
  const isCsv = firstDataLine && firstDataLine.split(',').length >= 2;

  if (isCsv) {
    // Try each column to find the one with CIDRs - whichever yields the most
    // valid normalisations wins. Robust to header presence.
    const rows = lines.map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    const colCount = Math.max(...rows.map(r => r.length));
    let bestCol = -1, bestHits = 0;
    for (let c = 0; c < colCount; c++) {
      let hits = 0;
      for (const r of rows) {
        if (normaliseCidr(r[c])) hits++;
      }
      if (hits > bestHits) { bestHits = hits; bestCol = c; }
    }
    if (bestHits > 0) {
      for (const r of rows) {
        const cell = r[bestCol];
        const cidr = normaliseCidr(cell);
        if (cidr) valid.add(cidr);
        else if (cell && cell.trim() && !cell.trim().startsWith('#')) {
          if (invalid.length < 20) invalid.push(cell);
        }
      }
      return { valid: [...valid], invalid };
    }
    // CSV mode found nothing - fall through to plain-list parser below
  }

  for (const line of lines) {
    const cidr = normaliseCidr(line);
    if (cidr) valid.add(cidr);
    else if (line.trim() && !line.trim().startsWith('#')) {
      if (invalid.length < 20) invalid.push(line.trim());
    }
  }

  return { valid: [...valid], invalid };
}

/**
 * Import a set of CIDRs as seeded snapshots.
 *
 * @param {ObjectId|string} workspaceId
 * @param {string[]} cidrs - already normalised
 * @param {object} opts
 *   - seedSource {string}  identifier for where this batch came from
 *   - seedDate   {string}  YYYY-MM-DD baseline date (default: 30 days ago)
 * @returns {{ imported: number, skipped: number }}
 */
async function importSeeds(workspaceId, cidrs, opts = {}) {
  const { CidrDailySnapshot } = getModels();

  if (!Array.isArray(cidrs) || cidrs.length === 0) {
    return { imported: 0, skipped: 0 };
  }

  const seedSource = opts.seedSource || 'manual_import';
  // Default to 30 days ago so seeds count as "prior days seen"
  // but don't show up in "today/yesterday/this week" snapshot views.
  const defaultDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const seedDate = opts.seedDate || defaultDate;

  let imported = 0, skipped = 0;

  for (const cidr of cidrs) {
    if (!cidr) { skipped++; continue; }
    try {
      const result = await CidrDailySnapshot.updateOne(
        { workspace_id: workspaceId, cidr, date: seedDate },
        {
          $set: {
            ip_version: getIpVersion(cidr),
            triggers: ['seed'],
            asn_org: '',
            country: '',
          },
          $setOnInsert: {
            workspace_id: workspaceId,
            cidr,
            date: seedDate,
            source: 'seed',
            seed_source: seedSource,
            hits: 0,
            unique_ips: 0,
            conversions: 0,
            max_burst_5min: 0,
            rapid_duplicate_count: 0,
            single_ip_hammer_count: 0,
            fake_ua_count: 0,
          },
        },
        { upsert: true }
      );
      if (result.upsertedCount > 0 || result.matchedCount > 0) imported++;
      else skipped++;
    } catch (err) {
      logger.warn('seed_import_error', { cidr, err: err.message });
      skipped++;
    }
  }

  logger.info('seed_import_complete', {
    workspace_id: String(workspaceId),
    seed_source: seedSource,
    seed_date: seedDate,
    imported,
    skipped,
  });

  return { imported, skipped };
}

module.exports = {
  normaliseCidr,
  parseText,
  importSeeds,
  getIpVersion,
};
