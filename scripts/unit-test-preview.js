// Unit tests for src/lib/preview.js - the visitor-rendered preview module.
//
// What this proves:
//   1. substitutePlaceholders correctly replaces all four {{placeholder}} forms
//   2. pickPreviewBody chooses the right HTML source from each page shape
//      (LandingPage with html_template, LandingPage with variants, SitePage with html)
//   3. renderPreview composes substitution + WP fingerprint injection correctly
//   4. The output has NO tracking artifacts (heartbeat, Clarity, auto-conv)
//   5. PREVIEW_PLACEHOLDERS values are admin-friendly (e.g., 'preview-click-id'
//      so screenshots don't expose real click IDs)

const assert = require('assert');
const path = require('path');
const {
  renderPreview,
  pickPreviewBody,
  substitutePlaceholders,
  PREVIEW_PLACEHOLDERS,
} = require(path.resolve(__dirname, '../src/lib/preview'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('substitutePlaceholders:');

test('Replaces all four standard placeholders', () => {
  const html = '<p>id={{click_id}} src={{utm_source}} med={{utm_medium}} cmp={{utm_campaign}}</p>';
  const out = substitutePlaceholders(html, {
    click_id: 'C', utm_source: 'S', utm_medium: 'M', utm_campaign: 'X',
  });
  assert.strictEqual(out, '<p>id=C src=S med=M cmp=X</p>');
});

test('Replaces multiple occurrences globally', () => {
  const html = '{{click_id}} {{click_id}} {{click_id}}';
  const out = substitutePlaceholders(html, { click_id: 'X' });
  assert.strictEqual(out, 'X X X');
});

test('Defaults to empty string for unset values', () => {
  const html = 'src={{utm_source}} med={{utm_medium}}';
  const out = substitutePlaceholders(html, { utm_source: 'A' });
  // utm_medium is not in our values object, should become ''
  assert.strictEqual(out, 'src=A med=');
});

test('Returns null/undefined/empty unchanged', () => {
  assert.strictEqual(substitutePlaceholders(null), null);
  assert.strictEqual(substitutePlaceholders(undefined), undefined);
  assert.strictEqual(substitutePlaceholders(''), '');
});

test('Default PREVIEW_PLACEHOLDERS values are admin-friendly', () => {
  // Distinctive values so accidentally-leaked screenshots don't expose
  // real click IDs and UTM data
  assert.strictEqual(PREVIEW_PLACEHOLDERS.click_id, 'preview-click-id');
  assert.strictEqual(PREVIEW_PLACEHOLDERS.utm_source, 'preview');
  assert.strictEqual(PREVIEW_PLACEHOLDERS.utm_medium, 'preview');
  assert.strictEqual(PREVIEW_PLACEHOLDERS.utm_campaign, 'preview');
});

console.log('\npickPreviewBody:');

test('SitePage shape: returns the html field', () => {
  const sp = { slug: 'home', html: '<h1>Home</h1>', meta: {} };
  assert.strictEqual(pickPreviewBody(sp), '<h1>Home</h1>');
});

test('LandingPage shape, no variants: returns html_template', () => {
  const lp = { name: 'Promo', html_template: '<h1>Buy</h1>', variants: [] };
  assert.strictEqual(pickPreviewBody(lp), '<h1>Buy</h1>');
});

test('LandingPage shape with variants: picks highest-weight variant', () => {
  const lp = {
    name: 'Promo',
    html_template: '<p>fallback</p>',
    variants: [
      { html: '<p>v1</p>', weight: 30 },
      { html: '<p>v2</p>', weight: 70 },
      { html: '<p>v3</p>', weight: 50 },
    ],
  };
  assert.strictEqual(pickPreviewBody(lp), '<p>v2</p>');
});

test('LandingPage with empty variants array falls back to html_template', () => {
  const lp = { name: 'X', html_template: '<p>tpl</p>', variants: [] };
  assert.strictEqual(pickPreviewBody(lp), '<p>tpl</p>');
});

test('Returns empty string for null page', () => {
  assert.strictEqual(pickPreviewBody(null), '');
  assert.strictEqual(pickPreviewBody(undefined), '');
});

test('Variant with no html falls back to html_template', () => {
  // Defensive: if a variant exists but has empty html, don't emit empty
  const lp = {
    html_template: '<p>tpl</p>',
    variants: [{ html: '', weight: 100 }],
  };
  assert.strictEqual(pickPreviewBody(lp), '<p>tpl</p>');
});

console.log('\nrenderPreview:');

test('Renders LandingPage with placeholders and WP meta injection', () => {
  const lp = {
    html_template: '<!DOCTYPE html><html><head><title>X</title></head><body>id={{click_id}}</body></html>',
  };
  const out = renderPreview(lp);
  // Placeholders substituted with default preview values
  assert.ok(out.includes('id=preview-click-id'), 'placeholder not substituted');
  // WP fingerprint injected
  assert.ok(/<meta name="generator" content="WordPress/.test(out), 'WP meta not injected');
  // Original head/body preserved
  assert.ok(out.includes('<title>X</title>'));
});

test('Renders SitePage by reading html field', () => {
  const sp = { slug: 'home', html: '<!DOCTYPE html><html><head></head><body>HOME</body></html>' };
  const out = renderPreview(sp);
  assert.ok(out.includes('HOME'));
  assert.ok(/<meta name="generator" content="WordPress/.test(out));
});

test('Allows placeholder override (for testing UTM-driven content)', () => {
  const lp = { html_template: '<p>src={{utm_source}}</p>' };
  const out = renderPreview(lp, { placeholders: { utm_source: 'facebook' } });
  assert.ok(out.includes('src=facebook'));
});

test('Returns a friendly empty-state message when page has no HTML', () => {
  const lp = { name: 'New Page', html_template: '', variants: [] };
  const out = renderPreview(lp);
  assert.ok(/no HTML configured/i.test(out), `expected friendly empty-state, got: ${out.slice(0, 200)}`);
});

test('Output has NO heartbeat, Clarity, or auto-conversion markers', () => {
  // The whole point of preview is to skip tracking. If any of these strings
  // appear, something is leaking from the live render path into preview.
  const lp = {
    html_template: '<!DOCTYPE html><html><head></head><body>page</body></html>',
  };
  const out = renderPreview(lp);
  assert.ok(!out.includes('bg-heartbeat'), 'heartbeat injected into preview');
  assert.ok(!out.includes('clarity.ms'), 'Clarity injected into preview');
  assert.ok(!out.includes('bg-auto-conv'), 'auto-conversion injected into preview');
  assert.ok(!out.includes('challenge'), 'challenge JS injected into preview');
});

test('skipWpFingerprint option suppresses meta injection', () => {
  const lp = { html_template: '<!DOCTYPE html><html><head></head><body>X</body></html>' };
  const out = renderPreview(lp, { skipWpFingerprint: true });
  assert.ok(!/<meta name="generator" content="WordPress/.test(out));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
