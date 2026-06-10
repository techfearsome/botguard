/**
 * IpgeoCache — caches ipgeolocation.io security API responses.
 *
 * Clean IPs expire after 24h, flagged IPs after 6h (residential proxies
 * rotate fast, so we need to re-check flagged IPs more frequently).
 */

'use strict';

const mongoose = require('mongoose');

const IpgeoCacheSchema = new mongoose.Schema({
  ip: { type: String, required: true, unique: true, index: true },

  // Raw security response
  threat_score:         { type: Number, default: 0 },
  is_proxy:             { type: Boolean, default: false },
  is_residential_proxy: { type: Boolean, default: false },
  is_vpn:               { type: Boolean, default: false },
  is_tor:               { type: Boolean, default: false },
  is_relay:             { type: Boolean, default: false },
  is_anonymous:         { type: Boolean, default: false },
  is_bot:               { type: Boolean, default: false },
  is_spam:              { type: Boolean, default: false },
  is_known_attacker:    { type: Boolean, default: false },
  is_cloud_provider:    { type: Boolean, default: false },

  // Provider attribution
  proxy_provider_names:  [{ type: String }],
  vpn_provider_names:    [{ type: String }],
  cloud_provider_name:   { type: String, default: '' },

  // Confidence & recency
  proxy_confidence_score: { type: Number, default: 0 },
  proxy_last_seen:        { type: String, default: '' },
  vpn_confidence_score:   { type: Number, default: 0 },
  vpn_last_seen:          { type: String, default: '' },

  // Cache metadata
  checked_at: { type: Date, default: Date.now },
  expires_at: { type: Date, required: true, index: true },
}, {
  timestamps: false,
});

// TTL index — MongoDB automatically deletes expired documents
IpgeoCacheSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('IpgeoCache', IpgeoCacheSchema);
