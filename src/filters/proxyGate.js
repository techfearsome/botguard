/**
 * Proxy gate filter.
 *
 * Tighter version of network-layer scoring. Where the network filter contributes a SCORE
 * that gets weighted against other layers, the proxy gate is a HARD GATE - if it fires,
 * the visit goes straight to the safe page regardless of any other signals.
 *
 * Reads from:
 *   1. ProxyCheck's verdict (is_proxy, proxy_type, risk_score, type)
 *   2. The ASN/term blacklist overlay's match (already merged into network flags)
 *
 * Per-category toggles let you tune aggressiveness:
 *   - block_vpn (default ON): ExpressVPN, NordVPN, ProtonVPN, etc.
 *   - block_tor (default ON): Tor exit nodes
 *   - block_public_proxy (default ON): open / public proxies
 *   - block_compromised (default ON): known-compromised hosts
 *   - block_hosting (default OFF): datacenter/hosting IPs (legitimate corporate VPNs land here)
 *   - max_risk_score (default 100): block when ProxyCheck's risk score exceeds this
 *
 * Returns:
 *   {
 *     blocked: bool,
 *     reason: string | null,           // which signal triggered the block
 *     flags: [...]
 *   }
 */
function proxyGateCheck({ enrichment = {}, networkFlags = [], campaign }) {
  const gate = campaign?.filter_config?.proxy_gate;
  if (!gate || !gate.enabled) {
    return { blocked: false, reason: null, flags: ['proxy_gate_off'] };
  }

  // --- 1. ProxyCheck-reported proxy types ---
  const proxyType = String(enrichment.proxy_type || '').toUpperCase();

  if (enrichment.is_proxy) {
    if (gate.block_tor && (proxyType === 'TOR' || proxyType.startsWith('BLACKLIST_TOR'))) {
      return { blocked: true, reason: 'tor', flags: ['proxy_gate_block_tor'] };
    }
    if (gate.block_vpn && (proxyType === 'VPN' || proxyType.startsWith('BLACKLIST_VPN'))) {
      return { blocked: true, reason: 'vpn', flags: ['proxy_gate_block_vpn'] };
    }
    if (gate.block_public_proxy && (proxyType === 'PUB' || proxyType === 'PUBLIC' || proxyType.startsWith('BLACKLIST_PROXY'))) {
      return { blocked: true, reason: 'public_proxy', flags: ['proxy_gate_block_public_proxy'] };
    }
    if (gate.block_compromised && (proxyType === 'COM' || proxyType === 'COMPROMISED')) {
      return { blocked: true, reason: 'compromised', flags: ['proxy_gate_block_compromised'] };
    }
    // Generic proxy match - use VPN setting as the catch-all since it's the most common
    if (gate.block_vpn && proxyType && proxyType !== 'TOR' && !proxyType.startsWith('BLACKLIST_HOSTING') && !proxyType.startsWith('BLACKLIST_DATACENTER')) {
      return { blocked: true, reason: 'proxy_other', flags: [`proxy_gate_block_${proxyType.toLowerCase()}`] };
    }
  }

  // --- 2. Datacenter / hosting IP (separate toggle, off by default) ---
  if (gate.block_hosting) {
    if (enrichment.ip_type === 'hosting' ||
        proxyType.startsWith('BLACKLIST_HOSTING') ||
        proxyType.startsWith('BLACKLIST_DATACENTER') ||
        networkFlags.includes('hosting_ip')) {
      return { blocked: true, reason: 'hosting', flags: ['proxy_gate_block_hosting'] };
    }
  }

  // --- 3. Risk score threshold ---
  const riskScore = Number(enrichment.risk_score || 0);
  const maxRisk = Number(gate.max_risk_score ?? 100);
  if (maxRisk < 100 && riskScore > maxRisk) {
    return {
      blocked: true,
      reason: 'risk_score',
      flags: [`proxy_gate_risk_${riskScore}_over_${maxRisk}`],
    };
  }

  return { blocked: false, reason: null, flags: ['proxy_gate_pass'] };
}

module.exports = { proxyGateCheck };
