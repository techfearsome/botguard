// Tests for the theme system:
//   - header.ejs sets data-theme correctly based on workspace settings
//   - settings.ejs renders the theme toggle with the right active state
//   - login.ejs renders standalone without ws/page (uses dark by default)

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

function renderTemplate(file, data) {
  const tplPath = path.join(viewsDir, file);
  const src = fs.readFileSync(tplPath, 'utf8');
  return ejs.render(src, data, { filename: tplPath, root: viewsDir });
}

console.log('Theme rendering:');

test('header.ejs defaults to data-theme="dark" when ws.settings is missing', () => {
  const html = renderTemplate('partials/header.ejs', {
    ws: { slug: 'test' },
    page: 'dashboard',
    title: 'Test',
  });
  assert.ok(/data-theme="dark"/.test(html), 'expected data-theme="dark" in <html> tag');
  assert.ok(!/data-theme="light"/.test(html), 'should NOT contain light theme');
});

test('header.ejs renders data-theme="light" when ws.settings.theme === "light"', () => {
  const html = renderTemplate('partials/header.ejs', {
    ws: { slug: 'test', settings: { theme: 'light' } },
    page: 'dashboard',
    title: 'Test',
  });
  assert.ok(/data-theme="light"/.test(html), 'expected data-theme="light"');
});

test('header.ejs renders data-theme="dark" when ws.settings.theme === "dark"', () => {
  const html = renderTemplate('partials/header.ejs', {
    ws: { slug: 'test', settings: { theme: 'dark' } },
    page: 'dashboard',
    title: 'Test',
  });
  assert.ok(/data-theme="dark"/.test(html), 'expected data-theme="dark"');
});

test('header.ejs ignores unknown theme values and falls back to dark', () => {
  // Defensive: even if Mongo somehow contained a stray value, we shouldn't render
  // an invalid data-theme attribute that would break the CSS variable lookups.
  const html = renderTemplate('partials/header.ejs', {
    ws: { slug: 'test', settings: { theme: 'cyberpunk' } },
    page: 'dashboard',
    title: 'Test',
  });
  assert.ok(/data-theme="dark"/.test(html));
  assert.ok(!/data-theme="cyberpunk"/.test(html));
});

test('header.ejs includes the live nav-pulse element', () => {
  // After we removed the inline keyframes block, .nav-pulse must still exist
  // as a class - admin.css owns the animation.
  const html = renderTemplate('partials/header.ejs', {
    ws: { slug: 'test' },
    page: 'live',
    title: 'Live',
  });
  assert.ok(/class="nav-pulse"/.test(html), 'nav-pulse element missing');
});

test('header.ejs marks the active page nav link', () => {
  const html = renderTemplate('partials/header.ejs', {
    ws: { slug: 'test' },
    page: 'campaigns',
    title: 'Campaigns',
  });
  // Should have href=/admin/campaigns class with "active" present
  const m = html.match(/<a href="\/admin\/campaigns"\s+class="([^"]*)">/);
  assert.ok(m, 'Campaigns link not found');
  assert.ok(m[1].includes('active'), `expected active class, got: ${m[1]}`);
});

console.log('\nLogin page:');

test('login.ejs renders standalone with data-theme="dark"', () => {
  const html = renderTemplate('login.ejs', {
    error: null,
    next_url: '/admin',
  });
  assert.ok(/data-theme="dark"/.test(html));
  assert.ok(/<form[^>]*method="POST"[^>]*action="\/admin\/login"/.test(html), 'login form missing');
  assert.ok(/name="username"/.test(html), 'username input missing');
  assert.ok(/name="password"/.test(html), 'password input missing');
});

test('login.ejs renders error message when error="invalid"', () => {
  const html = renderTemplate('login.ejs', {
    error: 'invalid',
    next_url: '/admin',
  });
  assert.ok(/Invalid username or password/.test(html));
  assert.ok(/login-err/.test(html));
});

test('login.ejs preserves next_url in hidden field', () => {
  const html = renderTemplate('login.ejs', {
    error: null,
    next_url: '/admin/conversions',
  });
  assert.ok(/<input type="hidden" name="next" value="\/admin\/conversions">/.test(html));
});

test('login.ejs does NOT render error block when error is null', () => {
  const html = renderTemplate('login.ejs', {
    error: null,
    next_url: '/admin',
  });
  assert.ok(!/login-err/.test(html));
});

console.log('\nSettings — theme toggle:');

test('settings.ejs marks Dark as active when no theme set (default)', () => {
  const html = renderTemplate('admin/settings.ejs', {
    ws: { slug: 'test', name: 'Test', api_keys: [], created_at: new Date(), settings: {} },
    page: 'settings',
    adminUser: 'admin',
    generated: null,
  });
  // Look for the dark <label> with is-active class
  const darkLabel = html.match(/<label[^>]*class="([^"]*)"[^>]*>\s*<input[^>]*value="dark"/);
  assert.ok(darkLabel, 'dark theme toggle option missing');
  assert.ok(darkLabel[1].includes('is-active'), `expected is-active on dark, got: ${darkLabel[1]}`);
});

test('settings.ejs marks Light as active when settings.theme === "light"', () => {
  const html = renderTemplate('admin/settings.ejs', {
    ws: { slug: 'test', name: 'Test', api_keys: [], created_at: new Date(), settings: { theme: 'light' } },
    page: 'settings',
    adminUser: 'admin',
    generated: null,
  });
  const lightLabel = html.match(/<label[^>]*class="([^"]*)"[^>]*>\s*<input[^>]*value="light"/);
  assert.ok(lightLabel, 'light theme toggle option missing');
  assert.ok(lightLabel[1].includes('is-active'), `expected is-active on light, got: ${lightLabel[1]}`);
});

test('settings.ejs theme form submits to /admin/settings/theme', () => {
  const html = renderTemplate('admin/settings.ejs', {
    ws: { slug: 'test', name: 'Test', api_keys: [], created_at: new Date(), settings: {} },
    page: 'settings',
    adminUser: 'admin',
    generated: null,
  });
  assert.ok(/action="\/admin\/settings\/theme"/.test(html), 'theme form action wrong');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
