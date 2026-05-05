// Unit tests for robots.txt and sitemap.xml generation.

const assert = require('assert');
const path = require('path');
const {
  buildRobotsTxt,
  buildSitemapXml,
  AI_CRAWLERS,
  INTERNAL_PATHS,
} = require(path.join(__dirname, '../src/lib/robotsAndSitemap'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('buildRobotsTxt - normal mode:');

test('Allows everyone by default (User-agent: *)', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  assert.ok(/User-agent: \*/.test(txt));
});

test('Body has WordPress-canonical opener (User-agent + wp-admin rules first)', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  // First three lines must match the stock WP shape exactly.
  const lines = txt.split('\n');
  assert.strictEqual(lines[0], 'User-agent: *');
  assert.strictEqual(lines[1], 'Disallow: /wp-admin/');
  assert.strictEqual(lines[2], 'Allow: /wp-admin/admin-ajax.php');
});

test('No leading comment lines (no fingerprint)', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  assert.ok(!/^#/.test(txt), 'first character must not start a comment');
  assert.ok(!/BotGuard/.test(txt), 'must not mention "BotGuard"');
});

test('Disallows /admin/', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  assert.ok(/Disallow: \/admin\//.test(txt));
});

test('Disallows /go/ (campaigns)', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  assert.ok(/Disallow: \/go\//.test(txt));
});

test('Disallows /cb/, /lv/, /px/, /healthz', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  for (const p of ['/cb/', '/lv/', '/px/', '/healthz']) {
    assert.ok(txt.includes(`Disallow: ${p}`), `missing Disallow for ${p}`);
  }
});

test('Allows /static/ explicitly (CSS/JS for ranking)', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  assert.ok(/Allow: \/static\//.test(txt));
});

test('Includes Sitemap URL with correct host + protocol', () => {
  const txt = buildRobotsTxt({ host: 'botguard.pagedrop.site', protocol: 'https' });
  assert.ok(/Sitemap: https:\/\/botguard\.pagedrop\.site\/sitemap\.xml/.test(txt));
});

test('Defaults to https protocol when not specified', () => {
  const txt = buildRobotsTxt({ host: 'example.com' });
  assert.ok(txt.includes('https://example.com/sitemap.xml'));
});

console.log('\nbuildRobotsTxt - custom root paths:');

test('Disallows each custom root_path', () => {
  const txt = buildRobotsTxt({
    host: 'example.com',
    disallowedRootPaths: ['promo', 'black-friday', 'special-offer'],
  });
  assert.ok(/Disallow: \/promo$/m.test(txt), `missing /promo: ${txt}`);
  assert.ok(/Disallow: \/black-friday$/m.test(txt));
  assert.ok(/Disallow: \/special-offer$/m.test(txt));
});

test('Empty root paths list works', () => {
  const txt = buildRobotsTxt({ host: 'example.com', disallowedRootPaths: [] });
  assert.ok(/User-agent: \*/.test(txt));
  // No campaign-specific Disallow lines
  assert.ok(!/Disallow: \/promo/.test(txt));
});

test('Skips empty/null entries in root path list', () => {
  const txt = buildRobotsTxt({
    host: 'example.com',
    disallowedRootPaths: ['promo', '', null, undefined, '   '],
  });
  // Should only have one custom Disallow (the valid 'promo')
  const customDisallows = txt.match(/^Disallow: \/[a-z]/gm) || [];
  // Internal paths /admin/ /cb/ /lv/ /px/ /go/ /healthz = 6, plus promo = 7
  assert.ok(customDisallows.length >= 7);
});

test('Lowercases and trims root path entries', () => {
  const txt = buildRobotsTxt({
    host: 'example.com',
    disallowedRootPaths: ['  PROMO  ', 'Black-Friday'],
  });
  assert.ok(/Disallow: \/promo$/m.test(txt));
  assert.ok(/Disallow: \/black-friday$/m.test(txt));
});

console.log('\nbuildRobotsTxt - indexable campaigns:');

test('Indexable campaigns get Allow: /go/<slug> emitted before blanket /go/ Disallow', () => {
  const txt = buildRobotsTxt({
    host: 'example.com',
    indexableCampaigns: [{ slug: 'public-promo' }, { slug: 'evergreen-offer' }],
  });
  assert.ok(txt.includes('Allow: /go/public-promo'));
  assert.ok(txt.includes('Allow: /go/evergreen-offer'));
  // Order matters: Allow lines come before the blanket Disallow: /go/
  const allowIdx = txt.indexOf('Allow: /go/public-promo');
  const disallowIdx = txt.indexOf('Disallow: /go/');
  assert.ok(allowIdx < disallowIdx, 'Allow must come before Disallow for longest-match precedence');
});

test('Indexable campaigns root_paths are NOT in the Disallow list (caller responsibility)', () => {
  // The list of disallowedRootPaths is built by listDisallowedRootPaths()
  // which already filters out indexable campaigns. This test confirms the
  // builder honors what the caller passes - it doesn't second-guess.
  const txt = buildRobotsTxt({
    host: 'example.com',
    disallowedRootPaths: ['paid-only-promo'],
    indexableCampaigns: [{ slug: 'public-slug', root_path: 'public-promo' }],
  });
  assert.ok(txt.includes('Disallow: /paid-only-promo'));
  assert.ok(!txt.includes('Disallow: /public-promo'),
    'indexable root_path should not have a Disallow line');
});

test('No indexable campaigns - no Allow rules for /go/', () => {
  const txt = buildRobotsTxt({ host: 'example.com', indexableCampaigns: [] });
  assert.ok(!/Allow: \/go\//.test(txt));
});

console.log('\nbuildRobotsTxt - noIndex mode (staging):');

test('noIndex=true disallows everything for everyone', () => {
  const txt = buildRobotsTxt({ host: 'staging.example.com', noIndex: true });
  assert.ok(/User-agent: \*/.test(txt));
  assert.ok(/Disallow: \/$/m.test(txt));
});

test('noIndex=true skips per-route Disallows (just one global rule)', () => {
  const txt = buildRobotsTxt({ host: 'staging.example.com', noIndex: true });
  // Should NOT contain Disallow: /admin/ etc - they're redundant with /
  assert.ok(!/Disallow: \/admin\//.test(txt));
  assert.ok(!/Disallow: \/go\//.test(txt));
});

test('noIndex=true skips Sitemap reference', () => {
  const txt = buildRobotsTxt({ host: 'staging.example.com', noIndex: true });
  assert.ok(!/Sitemap:/.test(txt));
});

console.log('\nbuildRobotsTxt - AI crawler block:');

test('blockAi=false (default) does NOT mention AI crawlers', () => {
  const txt = buildRobotsTxt({ host: 'example.com', blockAi: false });
  assert.ok(!txt.includes('GPTBot'));
  assert.ok(!txt.includes('ClaudeBot'));
});

test('blockAi=true adds Disallow: / for each AI crawler', () => {
  const txt = buildRobotsTxt({ host: 'example.com', blockAi: true });
  for (const ua of AI_CRAWLERS) {
    assert.ok(txt.includes(`User-agent: ${ua}`), `missing ${ua}`);
  }
});

test('blockAi=true still has the * policy AND the AI blocks', () => {
  const txt = buildRobotsTxt({ host: 'example.com', blockAi: true });
  // Should have BOTH the wildcard rule (with sitemap) and per-bot blocks.
  assert.ok(/User-agent: \*/.test(txt));
  assert.ok(/User-agent: GPTBot/.test(txt));
});

console.log('\nbuildSitemapXml:');

test('Renders valid XML with urlset namespace', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [] });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap-0\.9">/.test(xml));
});

test('Renders / for slug=home', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [{ slug: 'home' }] });
  assert.ok(xml.includes('<loc>https://example.com/</loc>'));
});

test('Renders /privacy for slug=privacy', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [{ slug: 'privacy' }] });
  assert.ok(xml.includes('<loc>https://example.com/privacy</loc>'));
});

test('Renders /terms for slug=terms', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [{ slug: 'terms' }] });
  assert.ok(xml.includes('<loc>https://example.com/terms</loc>'));
});

test('Renders /p/<slug> for arbitrary slugs', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [{ slug: 'about-us' }] });
  assert.ok(xml.includes('<loc>https://example.com/p/about-us</loc>'));
});

test('Includes lastmod when updated_at provided', () => {
  const xml = buildSitemapXml({
    host: 'example.com',
    publicPages: [{ slug: 'home', updated_at: new Date('2026-04-15T12:00:00Z') }],
  });
  assert.ok(xml.includes('<lastmod>2026-04-15</lastmod>'));
});

test('XML-escapes special characters in URLs', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [{ slug: 'a&b' }] });
  // The slug is encodeURIComponent'd first, so & becomes %26 - so no actual
  // escape needed. Test that we don't double-encode.
  assert.ok(xml.includes('a%26b'));
});

test('Empty publicPages list returns valid empty urlset', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [] });
  assert.ok(xml.includes('<urlset'));
  assert.ok(xml.includes('</urlset>'));
  assert.ok(!xml.includes('<url>'));
});

test('Skips entries with no slug', () => {
  const xml = buildSitemapXml({ host: 'example.com', publicPages: [{ slug: 'home' }, {}, null, { slug: 'terms' }] });
  const matches = (xml.match(/<url>/g) || []).length;
  assert.strictEqual(matches, 2);
});

test('Skips pages with meta.noindex=true', () => {
  const xml = buildSitemapXml({
    host: 'example.com',
    publicPages: [
      { slug: 'home' },
      { slug: 'private', meta: { noindex: true } },
      { slug: 'public-page' },
    ],
  });
  assert.ok(xml.includes('/p/public-page'));
  assert.ok(xml.includes('<loc>https://example.com/</loc>'));
  assert.ok(!xml.includes('/p/private'), 'noindex page leaked into sitemap');
});

console.log('\nbuildSitemapXml - indexable campaigns:');

test('Includes indexable campaign URLs - prefers root_path when present', () => {
  const xml = buildSitemapXml({
    host: 'example.com',
    indexableCampaigns: [{ slug: 'main-promo', root_path: 'promo' }],
  });
  assert.ok(xml.includes('<loc>https://example.com/promo</loc>'));
  assert.ok(!xml.includes('/go/main-promo'),
    'should prefer root_path over /go/<slug> to avoid duplicate URLs splitting rank');
});

test('Falls back to /go/<slug> if no root_path', () => {
  const xml = buildSitemapXml({
    host: 'example.com',
    indexableCampaigns: [{ slug: 'main-promo', root_path: '' }],
  });
  assert.ok(xml.includes('<loc>https://example.com/go/main-promo</loc>'));
});

test('Indexable campaigns get priority 0.8 (higher than site pages at 0.7)', () => {
  const xml = buildSitemapXml({
    host: 'example.com',
    publicPages: [{ slug: 'home' }],
    indexableCampaigns: [{ slug: 'promo' }],
  });
  // Both should have priority lines
  const matches = xml.match(/<priority>[\d.]+<\/priority>/g) || [];
  assert.strictEqual(matches.length, 2);
  assert.ok(xml.includes('<priority>0.8</priority>'));
  assert.ok(xml.includes('<priority>0.7</priority>'));
});

test('Does NOT include campaigns where indexable is missing/false', () => {
  // Builder doesn't second-guess - if caller didn't include the campaign in
  // indexableCampaigns, it doesn't appear. This test documents that contract.
  const xml = buildSitemapXml({
    host: 'example.com',
    indexableCampaigns: [],   // listIndexableCampaigns() returned nothing
  });
  assert.ok(!xml.includes('/promo'));
  assert.ok(!xml.includes('/go/'));
});

console.log('\nINTERNAL_PATHS sanity:');

test('INTERNAL_PATHS includes all current mounts', () => {
  for (const p of ['/admin', '/cb', '/lv', '/px', '/go', '/healthz']) {
    assert.ok(INTERNAL_PATHS.includes(p), `missing ${p}`);
  }
});

test('AI_CRAWLERS includes major training bots', () => {
  for (const ua of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot', 'CCBot']) {
    assert.ok(AI_CRAWLERS.includes(ua), `missing ${ua}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
