// Unit tests for the code-editor wiring on /admin/pages/new and
// /admin/site/<slug>/edit. We don't test CodeJar/Prism themselves (vendored
// libraries with their own test suites). We test that:
//
//   1. The HTML textarea has data-code-editor="html" so the upgrade script
//      finds it
//   2. The Prism + code-editor scripts are loaded on these pages
//   3. The auto-conversion-terms textarea is NOT marked for upgrade (it's
//      plain newline-separated text, not code)
//
// Without these tests, a future template refactor could silently drop the
// data attribute or the script tags and the editor would just stop working
// with no failing test to surface it.

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const viewsDir = path.resolve(__dirname, '../src/views');
const { localTime } = require(path.resolve(__dirname, '../src/lib/localTime'));

function renderTemplate(file, data) {
  const tplPath = path.join(viewsDir, file);
  const src = fs.readFileSync(tplPath, 'utf8');
  return ejs.render(src, { localTime, assetUrl: (p) => p + '?v=test', ...data }, { filename: tplPath, root: viewsDir });
}

console.log('Code editor wiring - /admin/pages/new (page_form.ejs):');

test('HTML Template textarea has data-code-editor="html"', () => {
  const html = renderTemplate('admin/page_form.ejs', {
    ws: { slug: 'test', settings: {} },
    lp: null,
    page: 'pages',
  });
  // Match the textarea named html_template specifically
  const m = html.match(/<textarea[^>]*name="html_template"[^>]*>/);
  assert.ok(m, 'html_template textarea not found');
  assert.ok(/data-code-editor="html"/.test(m[0]),
    `expected data-code-editor="html", got: ${m[0]}`);
});

test('auto_conversion_terms textarea is NOT marked for upgrade', () => {
  const html = renderTemplate('admin/page_form.ejs', {
    ws: { slug: 'test', settings: {} },
    lp: { kind: 'offer' },
    page: 'pages',
  });
  const m = html.match(/<textarea[^>]*name="auto_conversion_terms"[^>]*>/);
  assert.ok(m, 'auto_conversion_terms textarea not found');
  assert.ok(!/data-code-editor/.test(m[0]),
    'auto_conversion_terms should NOT have data-code-editor (it is plain text, not code)');
});

test('Prism script is loaded on the page', () => {
  const html = renderTemplate('admin/page_form.ejs', {
    ws: { slug: 'test', settings: {} },
    lp: null,
    page: 'pages',
  });
  assert.ok(/<script src="\/static\/js\/vendor\/prism\.js(\?[^"]*)?"/.test(html),
    'prism.js script tag missing');
});

test('code-editor.js script is loaded as module', () => {
  const html = renderTemplate('admin/page_form.ejs', {
    ws: { slug: 'test', settings: {} },
    lp: null,
    page: 'pages',
  });
  assert.ok(/<script src="\/static\/js\/code-editor\.js(\?[^"]*)?" type="module">/.test(html),
    'code-editor.js script tag missing or not a module');
});

console.log('\nCode editor wiring - /admin/site/<slug>/edit (site_form.ejs):');

test('HTML textarea has data-code-editor="html"', () => {
  const html = renderTemplate('admin/site_form.ejs', {
    ws: { slug: 'test', settings: {} },
    sp: { slug: 'home', html: '', enabled: true },
    page: 'site',
  });
  const m = html.match(/<textarea[^>]*name="html"[^>]*>/);
  assert.ok(m, 'html textarea not found');
  assert.ok(/data-code-editor="html"/.test(m[0]),
    `expected data-code-editor="html", got: ${m[0]}`);
});

test('Prism + code-editor scripts loaded', () => {
  const html = renderTemplate('admin/site_form.ejs', {
    ws: { slug: 'test', settings: {} },
    sp: { slug: 'home', html: '', enabled: true },
    page: 'site',
  });
  assert.ok(/<script src="\/static\/js\/vendor\/prism\.js(\?[^"]*)?"/.test(html));
  assert.ok(/<script src="\/static\/js\/code-editor\.js(\?[^"]*)?" type="module">/.test(html));
});

console.log('\nVendored asset existence:');

test('public/js/vendor/prism.js exists and looks like Prism', () => {
  const p = path.resolve(__dirname, '../public/js/vendor/prism.js');
  assert.ok(fs.existsSync(p), 'prism.js missing');
  const content = fs.readFileSync(p, 'utf8');
  // The file should mention "Prism" - sanity check that we vendored the
  // right thing rather than something getting truncated.
  assert.ok(/Prism/.test(content), 'prism.js does not look like Prism');
});

test('public/js/vendor/codejar.js exists and exports CodeJar', () => {
  const p = path.resolve(__dirname, '../public/js/vendor/codejar.js');
  assert.ok(fs.existsSync(p), 'codejar.js missing');
  const content = fs.readFileSync(p, 'utf8');
  // ESM export - this is what code-editor.js imports
  assert.ok(/export function CodeJar/.test(content), 'CodeJar export missing');
});

test('public/js/code-editor.js exists', () => {
  const p = path.resolve(__dirname, '../public/js/code-editor.js');
  assert.ok(fs.existsSync(p), 'code-editor.js missing');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(/import.*CodeJar/.test(content), 'CodeJar import missing in code-editor.js');
});

test('code-editor.js seeds empty contenteditable with a newline (empty-page focus fix)', () => {
  // Browser bug we hit in production: an empty <code contenteditable>
  // element has no caret position, so "New Page" forms with no initial
  // HTML showed an editor you couldn't type into. The fix is to seed the
  // contenteditable with at least a newline. This test guards against
  // a future refactor accidentally reverting that.
  const p = path.resolve(__dirname, '../public/js/code-editor.js');
  const content = fs.readFileSync(p, 'utf8');
  // We expect a transformation that ensures at least one trailing newline:
  // .replace(/\n*$/, '\n')   matches the seed pattern
  assert.ok(/replace\(\/\\n\*\$\/, '\\n'\)/.test(content),
    'newline seed transformation missing - empty editors will not be focusable');
});

test('code-editor.js strips trailing newline before saving to textarea', () => {
  // Symmetric with the seed above: we add a trailing newline for cursor
  // anchoring, then strip it before saving so the form value matches what
  // the user actually typed.
  const p = path.resolve(__dirname, '../public/js/code-editor.js');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(/replace\(\/\\n\$\/, ''\)/.test(content),
    'trailing-newline strip missing - saved values will have a phantom newline');
});

test('code-editor.js has wrap click handler (empty editor click-to-focus fix)', () => {
  // Without this, clicking the empty area of the editor wrapper fails
  // to focus the contenteditable in some browsers - the click lands on
  // the wrap <div>, not the <code> child.
  const p = path.resolve(__dirname, '../public/js/code-editor.js');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(/wrap\.addEventListener\('click'/.test(content),
    'wrap click handler missing - empty editor wont focus on click');
});

test('code-editor.js skips Prism on empty/whitespace content (preserves seed newline)', () => {
  // Prism.highlightElement strips innerHTML when there are no tokens to
  // render. On an empty/whitespace-only editor, that wipes the seed
  // newline we put in to anchor the cursor. The guard must check
  // textContent.trim() before calling Prism so the seed survives.
  // Without this, /admin/pages/new shows an editor that can't be focused.
  const p = path.resolve(__dirname, '../public/js/code-editor.js');
  const content = fs.readFileSync(p, 'utf8');
  // Look for the guard in the highlightHtml function. Match flexibly since
  // the exact code may shift slightly with future refactors but the intent
  // (don't highlight empty content) must remain.
  assert.ok(
    /textContent[\s\S]*?\.trim\(\)/.test(content),
    'Prism empty-content guard missing - empty editors will lose their cursor anchor'
  );
});

test('LICENSE files for vendored libraries are included (MIT attribution)', () => {
  // Vendoring third-party MIT-licensed code requires keeping the LICENSE
  // alongside the redistributed source. This test enforces that habit.
  for (const f of ['prism.LICENSE', 'codejar.LICENSE']) {
    const p = path.resolve(__dirname, '../public/js/vendor/', f);
    assert.ok(fs.existsSync(p), `${f} missing - vendored libs need their LICENSE`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
