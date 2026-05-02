// Unit tests for localTime - server emits, client localizes.

const assert = require('assert');
const path = require('path');
const { localTime } = require(path.join(__dirname, '../src/lib/localTime'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('localTime:');

test('Emits a <time> element with datetime attribute set to ISO string', () => {
  const html = localTime(new Date('2026-05-01T05:38:57.000Z'));
  assert.ok(/<time/.test(html), 'should emit <time> element');
  assert.ok(/datetime="2026-05-01T05:38:57\.000Z"/.test(html), 'datetime attr missing or wrong');
});

test('Includes data-format attribute (default datetime)', () => {
  const html = localTime(new Date());
  assert.ok(/data-format="datetime"/.test(html));
});

test('Accepts non-default format', () => {
  const html = localTime(new Date(), 'date');
  assert.ok(/data-format="date"/.test(html));
});

test('Accepts ISO string input (not just Date)', () => {
  const html = localTime('2026-05-01T05:38:57.000Z');
  assert.ok(/datetime="2026-05-01T05:38:57\.000Z"/.test(html));
});

test('Accepts millisecond number input', () => {
  const html = localTime(1746077937000);     // 2025-05-01 05:38:57 UTC
  assert.ok(/<time datetime="20\d{2}-/.test(html));
});

test('Renders muted dash when value is null', () => {
  const html = localTime(null);
  assert.ok(/muted/.test(html));
  assert.ok(!/<time/.test(html));
});

test('Renders muted dash when value is undefined', () => {
  const html = localTime(undefined);
  assert.ok(/muted/.test(html));
});

test('Renders muted dash when value is invalid date', () => {
  const html = localTime('not-a-date');
  assert.ok(/muted/.test(html));
  assert.ok(!/<time/.test(html));
});

test('Fallback text is the UTC ISO truncated form (readable without JS)', () => {
  const html = localTime(new Date('2026-05-01T05:38:57.000Z'));
  // Should contain "2026-05-01 05:38 UTC" between the tags
  assert.ok(/>2026-05-01 05:38 UTC</.test(html), `fallback wrong: ${html}`);
});

test('Unknown format falls back to "datetime"', () => {
  const html = localTime(new Date(), 'wat');
  assert.ok(/data-format="datetime"/.test(html));
});

test('All four valid formats are accepted', () => {
  for (const f of ['datetime', 'date', 'time', 'relative']) {
    const html = localTime(new Date(), f);
    assert.ok(html.includes(`data-format="${f}"`), `${f} missing`);
  }
});

test('Output is safe for HTML interpolation (no quotes/lt-gt in fallback)', () => {
  const html = localTime(new Date('2026-05-01T05:38:57.000Z'));
  // The fallback text inside the tag should not contain HTML-active chars
  // beyond the tag delimiters themselves. Inner text is YYYY-MM-DD HH:MM UTC.
  const innerMatch = html.match(/>([^<]*)</);
  assert.ok(innerMatch, 'no inner text');
  assert.ok(!/[<>"]/.test(innerMatch[1]), `inner text contains HTML chars: ${innerMatch[1]}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
