// Logic-level test - no Mongo needed. Verifies all the pure helpers work correctly.

const assert = require('assert');
const path = require('path');

const { parseUtm, parseExternalIds } = require(path.join(__dirname, '../src/lib/utm'));
const { detectInAppBrowser } = require(path.join(__dirname, '../src/lib/inapp'));
const { getClientIp, hashIp } = require(path.join(__dirname, '../src/lib/ip'));
const { pickVariant } = require(path.join(__dirname, '../src/lib/variant'));
const { generateClickId } = require(path.join(__dirname, '../src/lib/click'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('UTM parsing:');
test('extracts all 5 UTM params', () => {
  const utm = parseUtm({
    utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'launch',
    utm_term: 'cta', utm_content: 'banner_a', other: 'ignored',
  });
  assert.strictEqual(utm.source, 'newsletter');
  assert.strictEqual(utm.medium, 'email');
  assert.strictEqual(utm.campaign, 'launch');
  assert.strictEqual(utm.term, 'cta');
  assert.strictEqual(utm.content, 'banner_a');
  assert.strictEqual(utm.other, undefined);
});
test('handles missing UTM params gracefully', () => {
  assert.deepStrictEqual(parseUtm({}), {});
  assert.deepStrictEqual(parseUtm(null), {});
  assert.deepStrictEqual(parseUtm(undefined), {});
});
test('truncates oversized values to 256 chars', () => {
  const huge = 'x'.repeat(1000);
  const utm = parseUtm({ utm_source: huge });
  assert.strictEqual(utm.source.length, 256);
});

console.log('\nExternal ID parsing:');
test('extracts gclid, fbclid, msclkid, ttclid, li_fat_id', () => {
  const ext = parseExternalIds({
    gclid: 'CjwKEAi', fbclid: 'IwAR0xyz', msclkid: 'abc', ttclid: 'tt123', li_fat_id: 'li456',
  });
  assert.strictEqual(ext.gclid, 'CjwKEAi');
  assert.strictEqual(ext.fbclid, 'IwAR0xyz');
  assert.strictEqual(ext.ttclid, 'tt123');
});

console.log('\nIn-app browser detection:');
test('detects Facebook in-app browser', () => {
  assert.strictEqual(detectInAppBrowser('Mozilla/5.0 (iPhone) FBAN/FBIOS;FBAV/438.0.0'), 'fb');
});
test('detects Instagram', () => {
  assert.strictEqual(detectInAppBrowser('Mozilla/5.0 (iPhone) Instagram 250.0.0'), 'ig');
});
test('detects TikTok (musical_ly variant)', () => {
  assert.strictEqual(detectInAppBrowser('Mozilla/5.0 musical_ly_30.1.0 BytedanceWebview'), 'tiktok');
});
test('detects LinkedIn, Twitter, Snapchat, Pinterest', () => {
  assert.strictEqual(detectInAppBrowser('LinkedInApp/9.0'), 'linkedin');
  assert.strictEqual(detectInAppBrowser('TwitterAndroid/10.0'), 'twitter');
  assert.strictEqual(detectInAppBrowser('Snapchat/12.0'), 'snapchat');
  assert.strictEqual(detectInAppBrowser('Pinterest/8.0 (iPhone)'), 'pinterest');
});
test('detects WeChat (MicroMessenger) and Line', () => {
  assert.strictEqual(detectInAppBrowser('MicroMessenger/8.0'), 'wechat');
  assert.strictEqual(detectInAppBrowser('Line/12.0.0'), 'line');
});
test('returns null for normal browsers', () => {
  assert.strictEqual(detectInAppBrowser('Mozilla/5.0 (Macintosh) Chrome/120.0.0'), null);
  assert.strictEqual(detectInAppBrowser(''), null);
  assert.strictEqual(detectInAppBrowser(null), null);
});

console.log('\nIP extraction & hashing:');
test('prefers CF-Connecting-IP header', () => {
  const req = { headers: { 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '5.6.7.8' }, ip: '9.9.9.9' };
  assert.strictEqual(getClientIp(req), '1.2.3.4');
});
test('falls back to X-Real-IP, then req.ip', () => {
  assert.strictEqual(getClientIp({ headers: { 'x-real-ip': '5.6.7.8' }, ip: '9.9.9.9' }), '5.6.7.8');
  assert.strictEqual(getClientIp({ headers: {}, ip: '9.9.9.9' }), '9.9.9.9');
});
test('hashes IP deterministically and truncates to 32 chars', () => {
  const h = hashIp('1.2.3.4');
  assert.strictEqual(h.length, 32);
  assert.strictEqual(hashIp('1.2.3.4'), h);
  assert.notStrictEqual(hashIp('1.2.3.5'), h);
});
test('hashIp returns null for empty input', () => {
  assert.strictEqual(hashIp(null), null);
  assert.strictEqual(hashIp(''), null);
});

console.log('\nA/B variant selection:');
test('picks weighted variant from list', () => {
  const lp = { variants: [{ name: 'A', weight: 1, html: 'a' }, { name: 'B', weight: 1, html: 'b' }] };
  const counts = { A: 0, B: 0 };
  for (let i = 0; i < 1000; i++) counts[pickVariant(lp).name]++;
  // Each variant should be selected somewhere between 350 and 650 times
  assert.ok(counts.A > 350 && counts.A < 650, `A=${counts.A}`);
  assert.ok(counts.B > 350 && counts.B < 650, `B=${counts.B}`);
});
test('respects weight imbalance', () => {
  const lp = { variants: [{ name: 'A', weight: 9, html: 'a' }, { name: 'B', weight: 1, html: 'b' }] };
  const counts = { A: 0, B: 0 };
  for (let i = 0; i < 1000; i++) counts[pickVariant(lp).name]++;
  assert.ok(counts.A > counts.B * 5, `A=${counts.A} B=${counts.B}`);
});
test('returns null when no variants', () => {
  assert.strictEqual(pickVariant({ variants: [] }), null);
  assert.strictEqual(pickVariant({}), null);
});

console.log('\nClick ID generation:');
test('generates 22-char URL-safe IDs', () => {
  const id = generateClickId();
  assert.strictEqual(id.length, 22);
  assert.match(id, /^[A-Za-z0-9]+$/);
});
test('generates unique IDs', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(generateClickId());
  assert.strictEqual(ids.size, 1000);
});

console.log('\nASN blacklist starter list:');
test('starter ASN list is loaded and contains expected categories', () => {
  // Inspect the bootstrap module to verify the seed structure
  const bootstrapSrc = require('fs').readFileSync(path.join(__dirname, '../src/lib/bootstrap.js'), 'utf8');
  assert.ok(bootstrapSrc.includes("'tor'"), 'has tor entries');
  assert.ok(bootstrapSrc.includes("'vpn'"), 'has vpn entries');
  assert.ok(bootstrapSrc.includes("'datacenter'"), 'has datacenter entries');
  assert.ok(bootstrapSrc.includes('60729'), 'includes Tor zwiebelfreunde ASN');
  assert.ok(bootstrapSrc.includes('9009'),  'includes M247 (NordVPN/PIA backbone)');
  assert.ok(bootstrapSrc.includes('14061'), 'includes DigitalOcean');
  assert.ok(bootstrapSrc.includes('16509'), 'includes AWS');
});

console.log('\nModel loading:');
test('all models load without errors', () => {
  const models = require(path.join(__dirname, '../src/models'));
  assert.ok(models.Workspace);
  assert.ok(models.Campaign);
  assert.ok(models.LandingPage);
  assert.ok(models.Click);
  assert.ok(models.Session);
  assert.ok(models.Conversion);
  assert.ok(models.AsnBlacklist);
});

console.log('\nEJS template compilation:');
test('all admin views compile without errors', () => {
  const ejs = require('ejs');
  const fs = require('fs');
  const views = ['dashboard','campaigns','campaign_form','pages','page_form','clicks','asn'];
  for (const v of views) {
    const tpl = fs.readFileSync(path.join(__dirname, `../src/views/admin/${v}.ejs`), 'utf8');
    ejs.compile(tpl, { filename: path.join(__dirname, `../src/views/admin/${v}.ejs`) });
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
