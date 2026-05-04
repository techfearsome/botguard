// Unit tests for reservedPaths - the registry that prevents campaign URLs
// from shadowing system routes.

const assert = require('assert');
const path = require('path');
const {
  RESERVED_PATHS,
  validateRootPath,
  isReservedPath,
} = require(path.join(__dirname, '../src/lib/reservedPaths'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('reservedPaths.validateRootPath - empty/null:');

test('Empty string is valid (means no custom path)', () => {
  const r = validateRootPath('');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.normalized, '');
});

test('null is valid (means no custom path)', () => {
  const r = validateRootPath(null);
  assert.strictEqual(r.valid, true);
});

test('undefined is valid (means no custom path)', () => {
  const r = validateRootPath(undefined);
  assert.strictEqual(r.valid, true);
});

test('Whitespace-only is valid as empty', () => {
  const r = validateRootPath('   ');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.normalized, '');
});

console.log('\nreservedPaths.validateRootPath - format:');

test('Simple alphanumeric is accepted', () => {
  assert.strictEqual(validateRootPath('promo').valid, true);
  assert.strictEqual(validateRootPath('promo').normalized, 'promo');
});

test('Hyphens allowed in middle', () => {
  assert.strictEqual(validateRootPath('black-friday-2026').valid, true);
});

test('Underscores allowed in middle', () => {
  assert.strictEqual(validateRootPath('black_friday').valid, true);
});

test('Digits allowed', () => {
  assert.strictEqual(validateRootPath('q4-2026').valid, true);
  assert.strictEqual(validateRootPath('2026-promo').valid, true);
});

test('Strips leading slash', () => {
  const r = validateRootPath('/promo');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.normalized, 'promo');
});

test('Lowercases input', () => {
  const r = validateRootPath('Promo');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.normalized, 'promo');
});

test('Rejects 1-character path', () => {
  const r = validateRootPath('a');
  assert.strictEqual(r.valid, false);
  assert.ok(/at least 2/i.test(r.error));
});

test('Rejects path > 64 chars', () => {
  const r = validateRootPath('a'.repeat(65));
  assert.strictEqual(r.valid, false);
});

test('Accepts exactly 64 chars', () => {
  const r = validateRootPath('a' + 'b'.repeat(63));
  assert.strictEqual(r.valid, true);
});

test('Rejects starting with hyphen', () => {
  const r = validateRootPath('-promo');
  assert.strictEqual(r.valid, false);
});

test('Rejects starting with underscore', () => {
  const r = validateRootPath('_promo');
  assert.strictEqual(r.valid, false);
});

test('Rejects multi-segment paths', () => {
  const r = validateRootPath('promo/sub');
  assert.strictEqual(r.valid, false);
});

test('Rejects paths with dots', () => {
  assert.strictEqual(validateRootPath('promo.html').valid, false);
  assert.strictEqual(validateRootPath('.well-known').valid, false);
});

test('Rejects paths with spaces', () => {
  assert.strictEqual(validateRootPath('promo something').valid, false);
});

test('Rejects paths with special characters', () => {
  assert.strictEqual(validateRootPath('promo!').valid, false);
  assert.strictEqual(validateRootPath('promo@page').valid, false);
  assert.strictEqual(validateRootPath('promo?id=1').valid, false);
  assert.strictEqual(validateRootPath('promo#fragment').valid, false);
});

test('Rejects non-string input types', () => {
  assert.strictEqual(validateRootPath(123).valid, false);
  assert.strictEqual(validateRootPath({}).valid, false);
  assert.strictEqual(validateRootPath([]).valid, false);
});

console.log('\nreservedPaths.validateRootPath - reserved list:');

test('Rejects "admin" (live system path)', () => {
  const r = validateRootPath('admin');
  assert.strictEqual(r.valid, false);
  assert.ok(/reserved/i.test(r.error));
});

test('Rejects "go" (default campaign mount)', () => {
  assert.strictEqual(validateRootPath('go').valid, false);
});

test('Rejects "privacy" (live site page)', () => {
  assert.strictEqual(validateRootPath('privacy').valid, false);
});

test('Rejects "terms" (live site page)', () => {
  assert.strictEqual(validateRootPath('terms').valid, false);
});

test('Rejects "p" (custom site pages mount)', () => {
  assert.strictEqual(validateRootPath('p').valid, false);
});

test('Rejects "static" (assets mount)', () => {
  assert.strictEqual(validateRootPath('static').valid, false);
});

test('Rejects "healthz" (container healthcheck)', () => {
  assert.strictEqual(validateRootPath('healthz').valid, false);
});

test('Rejects "cb" (callback/postback mount)', () => {
  assert.strictEqual(validateRootPath('cb').valid, false);
});

test('Rejects "lv" (live presence mount)', () => {
  assert.strictEqual(validateRootPath('lv').valid, false);
});

test('Rejects "px" (pixel mount)', () => {
  assert.strictEqual(validateRootPath('px').valid, false);
});

test('Rejects "api" (reserved for future)', () => {
  assert.strictEqual(validateRootPath('api').valid, false);
});

test('Rejects "favicon.ico" via dot-path rule before reserved check', () => {
  // dots aren't allowed at all, so this fails at the format check
  assert.strictEqual(validateRootPath('favicon.ico').valid, false);
});

test('Reserved check is case-insensitive (Admin = admin)', () => {
  assert.strictEqual(validateRootPath('Admin').valid, false);
  assert.strictEqual(validateRootPath('ADMIN').valid, false);
});

test('"admin-promo" is OK (substring of reserved is fine, exact match required)', () => {
  // The reserved check is an exact-match against the slug, not a substring.
  // So "admin-promo" (which doesn't shadow /admin) is allowed.
  assert.strictEqual(validateRootPath('admin-promo').valid, true);
});

test('"goal" is OK (only "go" is reserved, not "go" prefix)', () => {
  assert.strictEqual(validateRootPath('goal').valid, true);
});

console.log('\nreservedPaths.isReservedPath:');

test('Returns true for live reserved paths', () => {
  assert.strictEqual(isReservedPath('admin'), true);
  assert.strictEqual(isReservedPath('go'), true);
  assert.strictEqual(isReservedPath('p'), true);
});

test('Returns true for case-mismatched input', () => {
  assert.strictEqual(isReservedPath('ADMIN'), true);
  assert.strictEqual(isReservedPath('Privacy'), true);
});

test('Returns false for unreserved paths', () => {
  assert.strictEqual(isReservedPath('promo'), false);
  assert.strictEqual(isReservedPath('black-friday'), false);
});

test('Returns false for null/undefined/non-string', () => {
  assert.strictEqual(isReservedPath(null), false);
  assert.strictEqual(isReservedPath(undefined), false);
  assert.strictEqual(isReservedPath(''), false);
  assert.strictEqual(isReservedPath(123), false);
});

console.log('\nReserved set sanity:');

test('RESERVED_PATHS contains known critical entries', () => {
  for (const p of ['admin', 'go', 'p', 'privacy', 'terms', 'static', 'healthz', 'cb', 'lv', 'px']) {
    assert.ok(RESERVED_PATHS.has(p), `missing critical reserved path: ${p}`);
  }
});

test('RESERVED_PATHS does not contain common campaign-friendly slugs', () => {
  for (const p of ['promo', 'black-friday', 'sale', 'offer', 'special']) {
    assert.ok(!RESERVED_PATHS.has(p), `should NOT reserve: ${p}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
