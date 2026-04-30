// Cross-component regression test for the cookie-name bug.
//
// This bug shipped twice: the auto-conversion runtime read 'bg_click' but /go
// wrote 'bg_cid'. Result: the runtime found no click_id on EVERY click and bailed
// silently. This test guards against the bug recurring.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const goSrc = fs.readFileSync(path.join(__dirname, '../src/routes/go.js'), 'utf8');
const acSrc = fs.readFileSync(path.join(__dirname, '../src/lib/autoConversion.js'), 'utf8');
const pixelSrc = fs.readFileSync(path.join(__dirname, '../src/routes/pixel.js'), 'utf8');

console.log('Cookie name consistency (cross-component regression):');

test('/go writes cookie named bg_cid', () => {
  // Find: const CLICK_COOKIE = 'XYZ';
  const m = goSrc.match(/const\s+CLICK_COOKIE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'CLICK_COOKIE constant not found in go.js');
  assert.strictEqual(m[1], 'bg_cid', `expected 'bg_cid', got '${m[1]}'`);
});

test('Auto-conversion runtime reads cookie named bg_cid (NOT bg_click)', () => {
  // The runtime calls getCookie('XYZ') to look up the click id.
  // It must match what /go writes.
  assert.ok(acSrc.includes("getCookie('bg_cid')"), 'runtime must read bg_cid cookie');
  assert.ok(!acSrc.includes("getCookie('bg_click')"), 'runtime must NOT read bg_click (regression)');
});

test('Pixel route also reads bg_cid (consistency across all conversion sources)', () => {
  // /px/conv reads the cookie too - it should match
  assert.ok(/req\.cookies\?\.bg_cid/.test(pixelSrc) || /req\.cookies\.bg_cid/.test(pixelSrc),
    'pixel route must read bg_cid cookie');
});

test('No stale bg_click references anywhere in src/', () => {
  // Comments and code alike - prevent re-introducing the bug
  const srcDir = path.join(__dirname, '../src');
  function walk(dir) {
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.js')) out.push(full);
    }
    return out;
  }
  const offenders = walk(srcDir).filter((f) => fs.readFileSync(f, 'utf8').includes('bg_click'));
  assert.deepStrictEqual(offenders, [], `files still mention bg_click: ${offenders.join(', ')}`);
});

test('Click cookie regex pattern in JSDoc is consistent', () => {
  // The README/docs comment in autoConversion.js should mention bg_cid
  assert.ok(acSrc.includes('bg_cid cookie'), 'documentation should reference bg_cid');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
