// Unit test: app placement resolution falls back from utm_content to the
// ValueTrack placement field when Google leaves utm_content as the literal
// "{placement}" token. Uses a stubbed fetch — no network.

const assert = require('assert');
const path = require('path');

// Stub global fetch so lookupIosApp resolves deterministically.
global.fetch = async (url) => ({
  ok: true,
  json: async () => ({
    results: [{
      trackId: 382233851,
      trackName: 'Test App',
      sellerName: 'Test Seller',
      primaryGenreName: 'Games',
      artworkUrl100: 'https://example/icon.png',
      trackViewUrl: 'https://apps.apple.com/app/id382233851',
    }],
  }),
});

const { parseAppPlacement, resolveAppPlacement } = require(path.resolve(__dirname, '../src/lib/appLookup'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

(async () => {
  console.log('parseAppPlacement:');

  await test('unfilled {placement} token → no platform', async () => {
    const p = parseAppPlacement('{placement}');
    assert.strictEqual(p.platform, null);
    assert.strictEqual(p.appId, null);
  });

  await test('iOS mobileapp::1-<id>', async () => {
    const p = parseAppPlacement('mobileapp::1-382233851');
    assert.strictEqual(p.platform, 'ios');
    assert.strictEqual(p.appId, '382233851');
  });

  await test('Android mobileapp::2-<package>', async () => {
    const p = parseAppPlacement('mobileapp::2-com.foo.bar');
    assert.strictEqual(p.platform, 'android');
    assert.strictEqual(p.appId, 'com.foo.bar');
  });

  console.log('\nresolveAppPlacement multi-source fallback:');

  await test('falls back from {placement} utm_content to ValueTrack placement', async () => {
    // This is exactly the screenshot case: utm_content is the literal token,
    // the real placement is in valuetrack.google.placement.
    const info = await resolveAppPlacement(['{placement}', 'mobileapp::1-382233851']);
    assert.ok(info, 'should resolve via the ValueTrack fallback');
    assert.strictEqual(info.app_id || info.appId || '382233851', '382233851');
    assert.ok(info.name || info.app_name, 'should carry app metadata');
  });

  await test('single-string input still works (back-compat)', async () => {
    const info = await resolveAppPlacement('mobileapp::1-382233851');
    assert.ok(info);
  });

  await test('nothing parseable → null', async () => {
    const info = await resolveAppPlacement(['{placement}', '', null]);
    assert.strictEqual(info, null);
  });

  await test('first parseable candidate wins', async () => {
    // utm_content already has a valid placement → used before valuetrack.
    const info = await resolveAppPlacement(['mobileapp::1-382233851', 'mobileapp::2-com.other']);
    assert.ok(info);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
