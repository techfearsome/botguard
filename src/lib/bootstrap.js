const { Workspace, AsnBlacklist } = require('../models');
const logger = require('./logger');

const DEFAULT_SLUG = process.env.DEFAULT_WORKSPACE_SLUG || 'default';

/**
 * Starter ASN blacklist - well-known offenders that ProxyCheck sometimes misses
 * or that we want to apply heavier scoring to than its defaults.
 *
 * This is intentionally conservative for a permissive setup. Add more via the admin panel.
 * Categorized so scoring can treat them differently per source profile.
 *
 * Mix of ASN-exact rules and term rules. Term rules match against ProxyCheck's
 * provider field (case-insensitive substring). They catch cases where ASN rotates
 * but the operator name doesn't.
 */
const STARTER_ASNS = [
  // ---- Tor & anonymity networks (ASN rules) ----
  { asn: 60729,  category: 'tor',         asn_org: 'Zwiebelfreunde e.V. (Tor exit)',   severity: 'hard_block', score_weight: 100 },
  { asn: 4224,   category: 'tor',         asn_org: 'CALYX-AS (Tor)',                    severity: 'hard_block', score_weight: 100 },
  { asn: 208323, category: 'tor',         asn_org: 'Foundation for Applied Privacy',    severity: 'hard_block', score_weight: 100 },

  // ---- Major VPN providers (ASN rules) ----
  { asn: 9009,   category: 'vpn',         asn_org: 'M247 Europe (NordVPN/PIA infra)',   severity: 'high',       score_weight: 70 },
  { asn: 60068,  category: 'vpn',         asn_org: 'CDN77 / Datacamp (PIA)',            severity: 'high',       score_weight: 70 },
  { asn: 212238, category: 'vpn',         asn_org: 'Datacamp / CDN77',                  severity: 'high',       score_weight: 70 },
  { asn: 51852,  category: 'vpn',         asn_org: 'Private Layer (VPN backbone)',      severity: 'high',       score_weight: 70 },
  { asn: 200651, category: 'vpn',         asn_org: 'FlokiNET (VPN/anonymity)',          severity: 'high',       score_weight: 70 },

  // ---- Cloud providers (ASN rules - real users won't be on residential) ----
  { asn: 14061,  category: 'datacenter',  asn_org: 'DigitalOcean',                      severity: 'medium',     score_weight: 40 },
  { asn: 16509,  category: 'datacenter',  asn_org: 'Amazon AWS',                        severity: 'medium',     score_weight: 40 },
  { asn: 14618,  category: 'datacenter',  asn_org: 'Amazon AWS',                        severity: 'medium',     score_weight: 40 },
  { asn: 15169,  category: 'datacenter',  asn_org: 'Google Cloud',                      severity: 'low',        score_weight: 25 },
  { asn: 8075,   category: 'datacenter',  asn_org: 'Microsoft Azure',                   severity: 'low',        score_weight: 25 },
  { asn: 63949,  category: 'datacenter',  asn_org: 'Linode',                            severity: 'medium',     score_weight: 40 },
  { asn: 20473,  category: 'datacenter',  asn_org: 'Vultr / Choopa',                    severity: 'medium',     score_weight: 40 },
  { asn: 24940,  category: 'datacenter',  asn_org: 'Hetzner',                           severity: 'medium',     score_weight: 40 },
  { asn: 16276,  category: 'datacenter',  asn_org: 'OVH',                               severity: 'medium',     score_weight: 40 },
  { asn: 51167,  category: 'datacenter',  asn_org: 'Contabo',                           severity: 'medium',     score_weight: 50 },

  // ---- Known scraper / proxy network heavy users (ASN rules) ----
  { asn: 53667,  category: 'proxy',       asn_org: 'PONYNET (residential proxy abuse)', severity: 'high',       score_weight: 60 },
  { asn: 174,    category: 'hosting',     asn_org: 'Cogent (mixed - hosting heavy)',    severity: 'low',        score_weight: 20 },

  // ---- Term rules: catch what ASN rules miss ----
  // Generic infrastructure markers - matches against ProxyCheck's provider field.
  // Lower scores because these are blunt and will hit some legit corporate proxies.
  { term: 'tor exit',         term_field: 'any',      category: 'tor',        severity: 'hard_block', score_weight: 100, notes: 'Catches Tor exits that ProxyCheck classifies but uses unrecognized ASN' },
  { term: 'tor relay',        term_field: 'any',      category: 'tor',        severity: 'high',       score_weight: 80 },
  { term: 'vpn',              term_field: 'provider', category: 'vpn',        severity: 'high',       score_weight: 60, notes: 'Provider name contains "vpn" - matches NordVPN, ExpressVPN, ProtonVPN, etc.' },
  { term: 'proxy',            term_field: 'provider', category: 'proxy',      severity: 'high',       score_weight: 60 },
  { term: 'anonymizer',       term_field: 'any',      category: 'proxy',      severity: 'high',       score_weight: 70 },
  { term: 'web hosting',      term_field: 'provider', category: 'hosting',    severity: 'low',        score_weight: 25, notes: 'Generic hosting providers - low score, just a flag' },
  { term: 'data center',      term_field: 'provider', category: 'datacenter', severity: 'low',        score_weight: 20 },
  { term: 'datacenter',       term_field: 'provider', category: 'datacenter', severity: 'low',        score_weight: 20 },
  { term: 'colocation',       term_field: 'provider', category: 'datacenter', severity: 'low',        score_weight: 25 },
  { term: 'server hosting',   term_field: 'provider', category: 'hosting',    severity: 'low',        score_weight: 25 },
  { term: 'dedicated server', term_field: 'provider', category: 'hosting',    severity: 'low',        score_weight: 20 },
  { term: 'bulletproof',      term_field: 'provider', category: 'spam',       severity: 'high',       score_weight: 80, notes: 'Bulletproof hosts are almost always abuse infrastructure' },

  // Specific provider-name term rules - more precise than category terms
  { term: 'm247',             term_field: 'provider', category: 'vpn',        severity: 'high',       score_weight: 70, notes: 'Catches M247 even when they shuffle ASNs' },
  { term: 'datacamp',         term_field: 'provider', category: 'vpn',        severity: 'high',       score_weight: 70 },
  { term: 'leaseweb',         term_field: 'provider', category: 'datacenter', severity: 'medium',     score_weight: 40 },
  { term: 'choopa',           term_field: 'provider', category: 'datacenter', severity: 'medium',     score_weight: 40 },
  { term: 'oracle cloud',     term_field: 'provider', category: 'datacenter', severity: 'medium',     score_weight: 35 },
  { term: 'alibaba',          term_field: 'provider', category: 'datacenter', severity: 'medium',     score_weight: 35 },
];

async function ensureDefaultWorkspace() {
  let ws = await Workspace.findOne({ slug: DEFAULT_SLUG });
  if (!ws) {
    ws = await Workspace.create({
      slug: DEFAULT_SLUG,
      name: 'TechFirio',
      owner_email: 'admin@techfirio.local',
    });
    logger.info('default_workspace_created', { slug: ws.slug, id: ws._id.toString() });
  }

  // Seed starter ASN blacklist (only if empty - won't overwrite manual entries)
  const existingCount = await AsnBlacklist.countDocuments({});
  if (existingCount === 0) {
    let inserted = 0;
    for (const entry of STARTER_ASNS) {
      try {
        await AsnBlacklist.create({
          ...entry,
          workspace_id: null,        // global - applies to all workspaces
          source: 'starter_seed',
          active: true,
        });
        inserted += 1;
      } catch (err) {
        // ignore duplicates
        if (err.code !== 11000) throw err;
      }
    }
    logger.info('asn_blacklist_seeded', { inserted });
  }

  return ws;
}

module.exports = { ensureDefaultWorkspace, DEFAULT_SLUG };
