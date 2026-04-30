// Week 3 unit tests - slug helper, UTM gate filter

const assert = require('assert');
const path = require('path');

const { slugify, resolveSlug, randomDigits } = require(path.join(__dirname, '../src/lib/slug'));
const { utmGateCheck } = require(path.join(__dirname, '../src/filters/utmGate'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

(async () => {

console.log('Slug generation:');

await test('slugify lowercases, replaces spaces with hyphens', () => {
  assert.strictEqual(slugify('My Awesome Campaign'), 'my-awesome-campaign');
});

await test('slugify drops special characters', () => {
  assert.strictEqual(slugify('50% off! @ Black Friday'), '50-off-black-friday');
});

await test('slugify handles accented characters', () => {
  assert.strictEqual(slugify('Café Promoção'), 'cafe-promocao');
});

await test('slugify collapses repeated hyphens', () => {
  assert.strictEqual(slugify('foo --- bar'), 'foo-bar');
});

await test('slugify trims leading/trailing hyphens', () => {
  assert.strictEqual(slugify('--foo--'), 'foo');
});

await test('slugify caps length at 60 chars', () => {
  const huge = 'word '.repeat(50);
  assert.ok(slugify(huge).length <= 60);
});

await test('slugify handles underscores as separators', () => {
  assert.strictEqual(slugify('my_great_campaign'), 'my-great-campaign');
});

await test('slugify returns empty string for empty/null input', () => {
  assert.strictEqual(slugify(null), '');
  assert.strictEqual(slugify(undefined), '');
  assert.strictEqual(slugify(''), '');
  assert.strictEqual(slugify('!!!'), '');
});

await test('randomDigits produces correct length', () => {
  assert.strictEqual(randomDigits(4).length, 4);
  assert.strictEqual(randomDigits(8).length, 8);
  assert.match(randomDigits(6), /^\d{6}$/);
});

console.log('\nresolveSlug collision handling:');

await test('uses provided slug when no collision', async () => {
  const slug = await resolveSlug('my-camp', 'My Campaign', async () => false);
  assert.strictEqual(slug, 'my-camp');
});

await test('derives from name when slug not provided', async () => {
  const slug = await resolveSlug('', 'Black Friday Promo', async () => false);
  assert.strictEqual(slug, 'black-friday-promo');
});

await test('derives from name when slug is whitespace only', async () => {
  const slug = await resolveSlug('   ', 'Test Page', async () => false);
  assert.strictEqual(slug, 'test-page');
});

await test('appends random suffix on collision', async () => {
  const taken = new Set(['demo']);
  const slug = await resolveSlug('demo', 'Demo', async (s) => taken.has(s));
  assert.notStrictEqual(slug, 'demo');
  assert.match(slug, /^demo-\d{4,}$/);
});

await test('keeps trying with longer suffixes if collisions persist', async () => {
  // Mock: first 5 candidates collide, 6th doesn't
  let calls = 0;
  const slug = await resolveSlug('foo', 'Foo', async () => {
    calls++;
    return calls <= 5;   // first 5 collide
  });
  assert.match(slug, /^foo(-\d+)?$/);
  assert.ok(calls >= 6);
});

await test('throws if it can\'t find unique slug after maxAttempts', async () => {
  let threw = false;
  try {
    await resolveSlug('forever', 'Forever', async () => true, { maxAttempts: 3 });
  } catch (e) {
    threw = true;
    assert.match(e.message, /Could not generate unique slug/);
  }
  assert.ok(threw);
});

await test('falls back to random ID when neither slug nor name is sluggable', async () => {
  const slug = await resolveSlug('!!!', '@#$', async () => false);
  assert.match(slug, /^item-\d+$/);
});

await test('sanitizes provided slug (e.g. trims and lowercases)', async () => {
  const slug = await resolveSlug('  My Campaign!!  ', 'fallback', async () => false);
  assert.strictEqual(slug, 'my-campaign');
});

console.log('\nUTM gate filter:');

await test('Gate disabled → never blocks, regardless of UTM presence', () => {
  const r1 = utmGateCheck({ utm: {}, campaign: { filter_config: { utm_gate: { enabled: false } } } });
  const r2 = utmGateCheck({ utm: { source: 'fb' }, campaign: { filter_config: { utm_gate: { enabled: false } } } });
  assert.strictEqual(r1.blocked, false);
  assert.strictEqual(r2.blocked, false);
  assert.ok(r1.flags.includes('utm_gate_off'));
});

await test('Gate enabled, all required keys present → pass', () => {
  const r = utmGateCheck({
    utm: { source: 'newsletter', medium: 'email', campaign: 'launch' },
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('utm_gate_pass'));
});

await test('Gate enabled, one required key missing → block', () => {
  const r = utmGateCheck({
    utm: { source: 'newsletter', medium: 'email' },   // missing utm_campaign
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.deepStrictEqual(r.missing_keys, ['campaign']);
  assert.ok(r.flags.includes('utm_gate_fail'));
  assert.ok(r.flags.includes('utm_missing_campaign'));
});

await test('Gate enabled, all required keys missing → block with all listed', () => {
  const r = utmGateCheck({
    utm: {},
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.deepStrictEqual(r.missing_keys.sort(), ['campaign', 'medium', 'source']);
});

await test('Empty string UTM value counts as missing', () => {
  const r = utmGateCheck({
    utm: { source: '', medium: 'email', campaign: 'launch' },
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.deepStrictEqual(r.missing_keys, ['source']);
});

await test('Whitespace-only UTM value counts as missing', () => {
  const r = utmGateCheck({
    utm: { source: '   ', medium: 'email', campaign: 'launch' },
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.deepStrictEqual(r.missing_keys, ['source']);
});

await test('Custom required_keys list is respected', () => {
  // Only source is required
  const r1 = utmGateCheck({
    utm: { source: 'fb' },
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: ['source'] } } },
  });
  assert.strictEqual(r1.blocked, false);

  // Term required and missing
  const r2 = utmGateCheck({
    utm: { source: 'fb', medium: 'cpc', campaign: 'q4' },
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: ['source', 'term'] } } },
  });
  assert.strictEqual(r2.blocked, true);
  assert.deepStrictEqual(r2.missing_keys, ['term']);
});

await test('Empty required_keys array falls back to default', () => {
  const r = utmGateCheck({
    utm: { source: 'fb' },
    campaign: { filter_config: { utm_gate: { enabled: true, required_keys: [] } } },
  });
  // Default is [source, medium, campaign] - missing medium and campaign
  assert.strictEqual(r.blocked, true);
  assert.deepStrictEqual(r.missing_keys.sort(), ['campaign', 'medium']);
});

await test('Missing utm_gate config → treat as disabled (no block)', () => {
  const r = utmGateCheck({ utm: {}, campaign: { filter_config: {} } });
  assert.strictEqual(r.blocked, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
})();
