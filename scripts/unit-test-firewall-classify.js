// Unit tests for FirewallEntry.classify - the function that decides whether
// a click's decision_reason should produce a firewall entry, and which
// reason_class to bucket it under.
//
// This is the gatekeeper for what pollutes the IP exclusion list. False
// positives here (e.g. UTM-gate blocks getting classified as 'bot') would
// poison Google Ads exclusions and AbuseIPDB submissions. Aggressive
// coverage is warranted.

const assert = require('assert');
const path = require('path');

// Stub mongoose so we don't need a live DB to require the model file
const mongoose = require('mongoose');
mongoose.set('strictQuery', false);

const { classify, REASON_CLASSES } = require(path.resolve(__dirname, '../src/models/FirewallEntry'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('REASON_CLASSES:');

test('Has the expected canonical set of classes', () => {
  assert.deepStrictEqual([...REASON_CLASSES].sort(), [
    'asn', 'bot', 'datacenter', 'hard_block', 'other', 'proxy', 'source',
  ]);
});

console.log('\nclassify - excluded categories (must return null):');

test('country_gate:US returns null (geographic, not fraud)', () => {
  assert.strictEqual(classify('country_gate:US'), null);
});

test('country_gate:not_in_allowlist returns null', () => {
  assert.strictEqual(classify('country_gate:not_in_allowlist'), null);
});

test('utm_gate:missing_source returns null (often false positive)', () => {
  assert.strictEqual(classify('utm_gate:missing_source'), null);
});

test('utm_gate:missing_source_medium returns null', () => {
  assert.strictEqual(classify('utm_gate:missing_source_medium'), null);
});

test('campaign_paused returns null', () => {
  assert.strictEqual(classify('campaign_paused'), null);
});

test('campaign_archived returns null', () => {
  assert.strictEqual(classify('campaign_archived'), null);
});

test('no_filters_yet returns null', () => {
  assert.strictEqual(classify('no_filters_yet'), null);
});

test('allow returns null (not a block at all)', () => {
  assert.strictEqual(classify('allow'), null);
});

test('under_threshold:50<70 returns null (visitor passed)', () => {
  assert.strictEqual(classify('under_threshold:50<70'), null);
});

test('null/undefined/empty returns null', () => {
  assert.strictEqual(classify(null), null);
  assert.strictEqual(classify(undefined), null);
  assert.strictEqual(classify(''), null);
});

test('Non-string input returns null', () => {
  assert.strictEqual(classify(42), null);
  assert.strictEqual(classify({}), null);
});

console.log('\nclassify - included categories:');

test('proxy_gate:proxy returns proxy', () => {
  assert.strictEqual(classify('proxy_gate:proxy'), 'proxy');
});

test('proxy_gate:vpn returns proxy', () => {
  assert.strictEqual(classify('proxy_gate:vpn'), 'proxy');
});

test('proxy_gate:tor returns proxy', () => {
  assert.strictEqual(classify('proxy_gate:tor'), 'proxy');
});

test('proxy_gate:datacenter returns datacenter (separate class)', () => {
  // Datacenter ASNs are different from anonymizing proxies - useful to
  // filter separately for export (you might want to exclude only true
  // proxies for Google Ads, leaving datacenter in for AbuseIPDB review).
  assert.strictEqual(classify('proxy_gate:datacenter'), 'datacenter');
});

test('proxy_gate:hosting returns datacenter (synonym for datacenter)', () => {
  assert.strictEqual(classify('proxy_gate:hosting'), 'datacenter');
});

test('asn_blacklist:13335 returns asn', () => {
  assert.strictEqual(classify('asn_blacklist:13335'), 'asn');
});

test('hard_block:headless_chrome returns hard_block', () => {
  assert.strictEqual(classify('hard_block:headless_chrome'), 'hard_block');
});

test('prefetcher:facebook returns bot', () => {
  assert.strictEqual(classify('prefetcher:facebook'), 'bot');
});

test('threshold:85>=70 returns bot (scoring caught it)', () => {
  assert.strictEqual(classify('threshold:85>=70'), 'bot');
});

test('source_mismatch:paid_from_organic returns source', () => {
  assert.strictEqual(classify('source_mismatch:paid_from_organic'), 'source');
});

test('challenge_failed:no_token returns bot', () => {
  assert.strictEqual(classify('challenge_failed:no_token'), 'bot');
});

test('headless:webdriver returns bot', () => {
  assert.strictEqual(classify('headless:webdriver'), 'bot');
});

test('Unknown reason returns "other" (still recorded)', () => {
  // We err on the side of recording unknown reasons - it's better to have
  // a slightly-less-clean exclusion list than to silently drop fraud
  // signals because the reason format changed.
  assert.strictEqual(classify('something_unexpected:xyz'), 'other');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
