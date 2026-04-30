// Week 2 unit tests - covers filters, scoring, decide engine, prefetcher detection.

const assert = require('assert');
const path = require('path');

const { headersFilter } = require(path.join(__dirname, '../src/filters/headers'));
const { refererFilter } = require(path.join(__dirname, '../src/filters/referer'));
const { behaviorFilter, hashFingerprint } = require(path.join(__dirname, '../src/filters/behavior'));
const { detectPrefetcher } = require(path.join(__dirname, '../src/lib/prefetchers'));
const { decide } = require(path.join(__dirname, '../src/scoring/decide'));
const { getProfile, PROFILES } = require(path.join(__dirname, '../src/scoring/profiles'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// =========================================================
console.log('Headers filter:');
// =========================================================

test('curl/wget UAs score as obvious bot', () => {
  const r1 = headersFilter({ headers: {}, userAgent: 'curl/7.85.0' });
  const r2 = headersFilter({ headers: {}, userAgent: 'Wget/1.21.2' });
  assert.ok(r1.flags.includes('ua_obvious_bot'), JSON.stringify(r1.flags));
  assert.ok(r2.flags.includes('ua_obvious_bot'));
  assert.ok(r1.score >= 90);
});

test('python-requests, Go HTTP, Java, headless flagged', () => {
  for (const ua of ['python-requests/2.28.1', 'Go-http-client/1.1', 'Java/17.0.1', 'HeadlessChrome/120.0.0']) {
    const r = headersFilter({ headers: {}, userAgent: ua });
    assert.ok(r.flags.includes('ua_obvious_bot'), `${ua} → ${r.flags}`);
  }
});

test('empty UA → ua_missing with high score', () => {
  const r = headersFilter({ headers: {}, userAgent: '' });
  assert.ok(r.flags.includes('ua_missing'));
  assert.ok(r.score >= 80);
});

test('real Chrome UA with full headers scores low', () => {
  const r = headersFilter({
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
    },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  assert.ok(r.score < 20, `score was ${r.score}, flags=${r.flags}`);
});

test('Mozilla UA without sec-fetch-* flagged', () => {
  const r = headersFilter({
    headers: {
      'accept': 'text/html,*/*',
      'accept-language': 'en-US',
      'accept-encoding': 'gzip',
      // no sec-fetch-*
    },
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120.0.0.0 Safari/537.36',
  });
  assert.ok(r.flags.includes('modern_ua_no_sec_fetch'));
});

test('Googlebot recognized as known crawler (medium score)', () => {
  const r = headersFilter({ headers: {}, userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
  assert.ok(r.flags.includes('ua_known_crawler'));
  assert.ok(!r.flags.includes('ua_obvious_bot'));
});

// =========================================================
console.log('\nPrefetcher detection:');
// =========================================================

test('SafeLinks UA detected', () => {
  const r = detectPrefetcher({ userAgent: 'BingPreview/1.0b' });
  assert.strictEqual(r.is_prefetcher, true);
  assert.strictEqual(r.kind, 'safelinks');
});

test('Mimecast / Proofpoint detected as security_gw', () => {
  assert.strictEqual(detectPrefetcher({ userAgent: 'Mimecast 1.0' }).kind, 'security_gw');
  assert.strictEqual(detectPrefetcher({ userAgent: 'urldefense.proofpoint.com' }).kind, 'security_gw');
  assert.strictEqual(detectPrefetcher({ userAgent: 'Barracuda' }).kind, 'security_gw');
});

test('Slack / Discord / Twitter unfurls detected as social_unfurl', () => {
  assert.strictEqual(detectPrefetcher({ userAgent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' }).kind, 'social_unfurl');
  assert.strictEqual(detectPrefetcher({ userAgent: 'Mozilla/5.0 (compatible; Discordbot/2.0)' }).kind, 'social_unfurl');
  assert.strictEqual(detectPrefetcher({ userAgent: 'Twitterbot/1.0' }).kind, 'social_unfurl');
});

test('Apple ASN with generic UA detected as apple_mpp', () => {
  const r = detectPrefetcher({ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit Safari', asn: 714 });
  assert.strictEqual(r.is_prefetcher, true);
  assert.strictEqual(r.kind, 'apple_mpp');
});

test('Real Chrome UA without prefetcher signals returns false', () => {
  const r = detectPrefetcher({ userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36' });
  assert.strictEqual(r.is_prefetcher, false);
});

// =========================================================
console.log('\nReferer filter:');
// =========================================================

test('utm_source=facebook + facebook.com referer → trust', () => {
  const r = refererFilter({ utm: { source: 'facebook' }, refererHost: 'm.facebook.com' });
  assert.strictEqual(r.score, 0);
  assert.ok(r.flags.includes('referer_matches_facebook'));
});

test('utm_source=facebook + google referer → mismatch (with score)', () => {
  const r = refererFilter({ utm: { source: 'facebook' }, refererHost: 'www.google.com' });
  assert.ok(r.score > 0);
  assert.ok(r.flags.some(f => f.includes('referer_mismatch_facebook')));
});

test('Email medium ignores missing referer', () => {
  const r = refererFilter({ utm: { source: 'newsletter', medium: 'email' }, refererHost: null });
  assert.strictEqual(r.score, 0);
});

test('Has fbclid but referer stripped → soft signal not blocking-grade', () => {
  const r = refererFilter({
    utm: { source: 'facebook' },
    refererHost: null,
    externalIds: { fbclid: 'abc123' },
  });
  assert.ok(r.score < 20, `score ${r.score}`);
  assert.ok(r.flags.includes('no_referer_but_click_id'));
});

test('In-app browser short-circuits referer check', () => {
  const r = refererFilter({
    utm: { source: 'facebook' },
    refererHost: null,
    inAppBrowser: 'fb',
  });
  assert.strictEqual(r.score, 0);
  assert.ok(r.flags.includes('inapp_fb'));
});

test('Google Ads doubleclick.net referer accepted for utm_source=google', () => {
  const r = refererFilter({ utm: { source: 'google' }, refererHost: 'ad.doubleclick.net' });
  assert.strictEqual(r.score, 0);
});

// =========================================================
console.log('\nBehavior filter:');
// =========================================================

test('No fingerprint → fp_pending with score 0', () => {
  const r = behaviorFilter({ fingerprint: null });
  assert.strictEqual(r.score, 0);
  assert.ok(r.flags.includes('fp_pending'));
});

test('Prefetcher → fp_skipped_prefetcher with score 0', () => {
  const r = behaviorFilter({ fingerprint: null, isPrefetcher: true });
  assert.strictEqual(r.score, 0);
  assert.ok(r.flags.includes('fp_skipped_prefetcher'));
});

test('SwiftShader webgl → webgl_headless with high score', () => {
  const r = behaviorFilter({ fingerprint: { canvas: 'abc', webgl: 'Google SwiftShader', screen: '1920x1080', tz: 'UTC', lang: 'en' } });
  assert.ok(r.flags.includes('webgl_headless'));
  assert.ok(r.score >= 50);
});

test('webdriver=true → webdriver_flag with score 80', () => {
  const r = behaviorFilter({ fingerprint: { canvas: 'abc', webgl: 'Intel Iris', screen: '1920x1080', tz: 'UTC', lang: 'en', webdriver: true } });
  assert.ok(r.flags.includes('webdriver_flag'));
  assert.ok(r.score >= 80);
});

test('Healthy fingerprint with mouse interaction scores low', () => {
  const r = behaviorFilter({
    fingerprint: { canvas: 'a3f29b', webgl: 'Apple GPU', screen: '1440x900', tz: 'America/Los_Angeles', lang: 'en-US', interaction: 'mouse' },
  });
  assert.ok(r.score < 10, `score was ${r.score}, flags=${r.flags}`);
  assert.ok(r.flags.includes('has_interaction'));
});

test('hashFingerprint is deterministic and 32 chars', () => {
  const fp = { canvas: 'a', webgl: 'b', screen: '100x100', tz: 'UTC', lang: 'en', platform: 'MacIntel' };
  const h1 = hashFingerprint(fp);
  const h2 = hashFingerprint(fp);
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 32);
});

// =========================================================
console.log('\nProfiles:');
// =========================================================

test('All 5 profiles defined with weights for all 5 layers', () => {
  for (const name of ['email','paid_ads','organic','affiliate','mixed']) {
    const p = getProfile(name);
    for (const layer of ['network','headers','behavior','pattern','referer']) {
      assert.ok(typeof p.weights[layer] === 'number', `${name}.${layer} missing`);
    }
    assert.ok(typeof p.threshold_default === 'number');
  }
});

test('Email profile has higher threshold than paid_ads', () => {
  assert.ok(getProfile('email').threshold_default > getProfile('paid_ads').threshold_default);
});

test('Affiliate profile weights pattern higher than email', () => {
  assert.ok(getProfile('affiliate').weights.pattern > getProfile('email').weights.pattern);
});

test('Unknown profile name falls back to mixed', () => {
  assert.deepStrictEqual(getProfile('does-not-exist'), PROFILES.mixed);
});

// =========================================================
console.log('\nDecide engine:');
// =========================================================

test('Total score under threshold → allow', () => {
  const r = decide({
    layerScores: { network: 10, headers: 5, behavior: 0, pattern: 0, referer: 0 },
    layerFlags:  { network: [], headers: [], behavior: [], pattern: [], referer: [] },
    profile: 'mixed',
    campaign: { filter_config: { threshold: 70, mode: 'enforce' } },
  });
  assert.strictEqual(r.decision, 'allow');
  assert.ok(r.total < 70);
});

test('Total score over threshold + enforce → block', () => {
  const r = decide({
    layerScores: { network: 90, headers: 90, behavior: 90, pattern: 90, referer: 90 },
    layerFlags:  { network: [], headers: [], behavior: [], pattern: [], referer: [] },
    profile: 'mixed',
    campaign: { filter_config: { threshold: 70, mode: 'enforce' } },
  });
  assert.strictEqual(r.decision, 'block');
});

test('Total score over threshold + log_only → would_block', () => {
  const r = decide({
    layerScores: { network: 90, headers: 90, behavior: 90, pattern: 90, referer: 90 },
    layerFlags:  { network: [], headers: [], behavior: [], pattern: [], referer: [] },
    profile: 'mixed',
    campaign: { filter_config: { threshold: 70, mode: 'log_only' } },
  });
  assert.strictEqual(r.decision, 'would_block');
});

test('Hard-block flag in enforce mode → block regardless of score', () => {
  const r = decide({
    layerScores: { network: 0, headers: 0, behavior: 0, pattern: 0, referer: 0 },
    layerFlags:  { network: ['asn_hard_block'], headers: [], behavior: [], pattern: [], referer: [] },
    profile: 'mixed',
    campaign: { filter_config: { threshold: 70, mode: 'enforce' } },
  });
  assert.strictEqual(r.decision, 'block');
  assert.ok(r.decision_reason.includes('hard_block'));
});

test('Prefetcher always allowed regardless of score', () => {
  const r = decide({
    layerScores: { network: 0, headers: 100, behavior: 100, pattern: 0, referer: 0 },
    layerFlags:  { network: ['prefetcher_safelinks'], headers: ['ua_obvious_bot'], behavior: [], pattern: [], referer: [] },
    profile: 'paid_ads',
    campaign: { filter_config: { threshold: 50, mode: 'enforce' } },
    prefetcher: { is_prefetcher: true, kind: 'safelinks' },
  });
  assert.strictEqual(r.decision, 'allow');
  assert.ok(r.decision_reason.startsWith('prefetcher:'));
});

test('Email profile is more forgiving than paid_ads for the same network signals', () => {
  // Email profile down-weights network/headers/behavior (0.5 each) and ignores referer.
  // Paid_ads weights network at 1.5 and referer at 1.0. With high network + low pattern,
  // paid_ads should produce a noticeably higher total.
  const layerScores = { network: 80, headers: 30, behavior: 30, pattern: 0, referer: 0 };
  const layerFlags  = { network: [], headers: [], behavior: [], pattern: [], referer: [] };
  const campaign    = { filter_config: { threshold: 70, mode: 'enforce' } };

  const emailR = decide({ layerScores, layerFlags, profile: 'email', campaign });
  const adsR   = decide({ layerScores, layerFlags, profile: 'paid_ads', campaign });

  assert.ok(emailR.total < adsR.total, `email=${emailR.total} ads=${adsR.total} (expected email < ads)`);
});

test('webdriver_flag is a hard-block', () => {
  const r = decide({
    layerScores: { network: 0, headers: 0, behavior: 100, pattern: 0, referer: 0 },
    layerFlags:  { network: [], headers: [], behavior: ['webdriver_flag'], pattern: [], referer: [] },
    profile: 'mixed',
    campaign: { filter_config: { threshold: 70, mode: 'enforce' } },
  });
  assert.strictEqual(r.decision, 'block');
  assert.ok(r.decision_reason.includes('hard_block'));
});

// =========================================================
console.log('\nFilter chain integration:');
// =========================================================

test('runFilterChain produces well-formed output even with no Mongo/Redis', async () => {
  const { runFilterChain } = require(path.join(__dirname, '../src/lib/filterChain'));
  const result = await runFilterChain({
    ip: '8.8.8.8',
    ipHash: 'abc',
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120.0.0.0 Safari/537.36',
    headers: { 'accept': 'text/html,*/*', 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip, br', 'sec-fetch-mode': 'navigate' },
    utm: { source: 'newsletter', medium: 'email' },
    externalIds: {},
    refererHost: null,
    inAppBrowser: null,
    fingerprint: null,
    workspaceId: null,
    campaign: { source_profile: 'email', filter_config: { threshold: 80, mode: 'log_only' } },
  });

  assert.ok(typeof result.scores.network === 'number');
  assert.ok(typeof result.scores.total === 'number');
  assert.ok(['allow','block','would_block'].includes(result.decision));
  assert.strictEqual(result.scores.profile_used, 'email');
});

test('Bot UA + datacenter ASN should produce high score', async () => {
  const { runFilterChain } = require(path.join(__dirname, '../src/lib/filterChain'));
  const result = await runFilterChain({
    ip: null,
    ipHash: null,
    userAgent: 'curl/7.85.0',
    headers: {},
    utm: { source: 'facebook' },
    externalIds: {},
    refererHost: 'random-site.com',
    inAppBrowser: null,
    fingerprint: null,
    workspaceId: null,
    campaign: { source_profile: 'paid_ads', filter_config: { threshold: 65, mode: 'enforce' } },
  });

  assert.ok(result.scores.headers >= 80, `headers=${result.scores.headers}`);
  assert.ok(result.scores.referer > 0, `referer=${result.scores.referer}`);
  // With paid_ads weights and these scores, total should be over 65 threshold
  assert.strictEqual(result.decision, 'block', `decision=${result.decision} total=${result.scores.total}`);
});

test('Real browser + email source + matching context → allow', async () => {
  const { runFilterChain } = require(path.join(__dirname, '../src/lib/filterChain'));
  const result = await runFilterChain({
    ip: null,
    ipHash: null,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    },
    utm: { source: 'newsletter', medium: 'email', campaign: 'q4-launch' },
    externalIds: {},
    refererHost: null,
    inAppBrowser: null,
    fingerprint: null,
    workspaceId: null,
    campaign: { source_profile: 'email', filter_config: { threshold: 80, mode: 'enforce' } },
  });

  assert.strictEqual(result.decision, 'allow', `total=${result.scores.total} flags=${result.scores.flags}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
