// Tests for device classification + per-device page resolver

const assert = require('assert');
const path = require('path');
const UAParser = require('ua-parser-js');

const { classifyDeviceClass, ALL_DEVICE_CLASSES } = require(path.join(__dirname, '../src/lib/deviceClass'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('Device class classification:');

const cases = [
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',  expect: 'iphone' },
  { ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',          expect: 'other' },
  { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',      expect: 'android' },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',             expect: 'android' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',      expect: 'mac' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',            expect: 'windows' },
  { ua: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',                          expect: 'linux' },
  { ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',              expect: 'linux' },
  { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',                                expect: 'other' },
  { ua: 'curl/8.4.0', expect: 'other' },
  { ua: '', expect: 'other' },
];

for (const c of cases) {
  test(`"${c.ua.slice(0, 50) + (c.ua.length > 50 ? '…' : '')}" → ${c.expect}`, () => {
    const parsed = new UAParser(c.ua).getResult();
    assert.strictEqual(classifyDeviceClass(parsed), c.expect);
  });
}

test('null input → other', () => {
  assert.strictEqual(classifyDeviceClass(null), 'other');
});

test('iPhone in Facebook in-app browser still classifies as iphone', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/438.0.0.0]';
  const parsed = new UAParser(ua).getResult();
  assert.strictEqual(classifyDeviceClass(parsed), 'iphone');
});

test('Android in Instagram still classifies as android', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 250.0.0.21.109';
  const parsed = new UAParser(ua).getResult();
  assert.strictEqual(classifyDeviceClass(parsed), 'android');
});

test('ALL_DEVICE_CLASSES contains exactly the 6 expected classes', () => {
  assert.deepStrictEqual([...ALL_DEVICE_CLASSES].sort(), ['android', 'iphone', 'linux', 'mac', 'other', 'windows']);
});

console.log('\nPage resolver:');

// Stub the LandingPage model to test resolver logic without Mongo
const modelsPath = path.resolve(__dirname, '../src/models');
const stubPages = {};
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    LandingPage: { findById: async (id) => stubPages[id] || null },
  },
};
const { resolvePageForDevice } = require(path.join(__dirname, '../src/lib/pageResolver'));

(async () => {
  await test('Returns device-specific offer when set', async () => {
    stubPages['ip_offer'] = { _id: 'ip_offer', name: 'iPhone offer' };
    stubPages['default_offer'] = { _id: 'default_offer', name: 'Default offer' };
    const campaign = {
      landing_page_id: 'default_offer',
      device_pages: { iphone: { offer: 'ip_offer' } },
    };
    const r = await resolvePageForDevice(campaign, 'iphone', 'offer');
    assert.strictEqual(r._id, 'ip_offer');
  });

  await test('Falls back to campaign default when no device override', async () => {
    stubPages['default_offer'] = { _id: 'default_offer', name: 'Default offer' };
    const campaign = {
      landing_page_id: 'default_offer',
      device_pages: { iphone: { offer: 'ip_offer' } },     // android isn't overridden
    };
    const r = await resolvePageForDevice(campaign, 'android', 'offer');
    assert.strictEqual(r._id, 'default_offer');
  });

  await test('Falls back when device override points to deleted page', async () => {
    delete stubPages['deleted'];
    stubPages['default_offer'] = { _id: 'default_offer', name: 'Default offer' };
    const campaign = {
      landing_page_id: 'default_offer',
      device_pages: { iphone: { offer: 'deleted' } },
    };
    const r = await resolvePageForDevice(campaign, 'iphone', 'offer');
    assert.strictEqual(r._id, 'default_offer');
  });

  await test('Returns null when no override AND no default', async () => {
    const campaign = { device_pages: {} };
    const r = await resolvePageForDevice(campaign, 'iphone', 'offer');
    assert.strictEqual(r, null);
  });

  await test('Resolves safe page separately from offer', async () => {
    stubPages['ip_safe'] = { _id: 'ip_safe', name: 'iPhone safe' };
    stubPages['default_safe'] = { _id: 'default_safe', name: 'Default safe' };
    const campaign = {
      safe_page_id: 'default_safe',
      device_pages: { iphone: { safe: 'ip_safe' } },
    };
    const r = await resolvePageForDevice(campaign, 'iphone', 'safe');
    assert.strictEqual(r._id, 'ip_safe');
  });

  await test('Per-device offer set but no per-device safe → safe falls back', async () => {
    stubPages['ip_offer'] = { _id: 'ip_offer', name: 'iPhone offer' };
    stubPages['default_safe'] = { _id: 'default_safe', name: 'Default safe' };
    const campaign = {
      landing_page_id: 'default_offer',
      safe_page_id: 'default_safe',
      device_pages: { iphone: { offer: 'ip_offer' } },     // no safe override
    };
    const r = await resolvePageForDevice(campaign, 'iphone', 'safe');
    assert.strictEqual(r._id, 'default_safe');
  });

  await test('null campaign → null result, no crash', async () => {
    const r = await resolvePageForDevice(null, 'iphone', 'offer');
    assert.strictEqual(r, null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
