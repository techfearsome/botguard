const express = require('express');
const router = express.Router();

const { SyncPartner, CidrIntelligence, AsnBlacklist } = require('../models');
const logger = require('../lib/logger');

/**
 * GET /sync/feed?key=<passcode>
 *
 * Read-only threat-intel feed for federated sharing. A remote BotGuard install
 * (or anyone the owner handed a URL + passcode to) pulls the exporter's shared
 * CIDR intelligence and/or ASN rules. What's shared is controlled entirely by
 * the matching export SyncPartner record — data type toggles, min score, and
 * whether sample IPs are included (off by default).
 *
 * Auth: per-partner passcode. Each partner has its own, so one can be revoked
 * without affecting others, and pulls are attributable.
 */
async function handleFeed(req, res) {
  res.set('Cache-Control', 'no-store');

  const passcode = (req.query.key || req.headers['x-sync-key'] || '').toString();
  if (!passcode || passcode.length < 8) {
    return res.status(401).json({ ok: false, error: 'missing_or_invalid_key' });
  }

  // Look up the export partner by passcode. Passcodes are per-partner and
  // reasonably long/random, so this is the credential.
  const partner = await SyncPartner.findOne({
    direction: 'export',
    passcode,
    enabled: true,
  });
  if (!partner) {
    // Don't distinguish "wrong key" from "disabled" — avoid probing.
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  try {
    const out = { generated_at: new Date().toISOString(), cidr: [], asn: [] };
    const minScore = partner.share?.min_score ?? 60;

    if (partner.share?.cidr) {
      const docs = await CidrIntelligence.find({
        workspace_id: partner.workspace_id,
        score: { $gte: minScore },
        status: { $in: ['new', 'reviewing', 'watchlist', 'blocked', 'exported'] },
      })
        .sort({ score: -1 })
        .limit(5000)
        .select('cidr score frequency_label ip_version asn_org country hit_count sample_ips')
        .lean();

      out.cidr = docs.map((d) => {
        const row = {
          cidr: d.cidr,
          score: d.score,
          label: d.frequency_label || '',
          ip_version: d.ip_version,
          asn_org: d.asn_org || '',
          country: d.country || '',
          hits: d.hit_count || 0,
        };
        // Sample IPs are your visitors' addresses — only included if the
        // exporter explicitly opted this partner in.
        if (partner.share?.sample_ips && Array.isArray(d.sample_ips)) {
          row.sample_ips = d.sample_ips.slice(0, 5);
        }
        return row;
      });
    }

    if (partner.share?.asn) {
      const rules = await AsnBlacklist.find({
        workspace_id: partner.workspace_id,
        active: true,
        asn: { $ne: null },
      })
        .limit(5000)
        .select('asn asn_org category severity')
        .lean();

      out.asn = rules.map((r) => ({
        asn: r.asn,
        asn_org: r.asn_org || '',
        category: r.category || 'other',
        severity: r.severity || 'high',
      }));
    }

    // Book-keeping for the dashboard.
    partner.export_count = (partner.export_count || 0) + 1;
    partner.last_exported_at = new Date();
    partner.last_export_size = out.cidr.length + out.asn.length;
    await partner.save();

    logger.info('sync_feed_served', {
      partner: partner.name,
      cidr: out.cidr.length,
      asn: out.asn.length,
    });
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error('sync_feed_error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
}

router.get('/feed', handleFeed);

module.exports = router;
