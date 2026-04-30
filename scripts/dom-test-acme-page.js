// DOM test against the exact "Acme Industries" landing page the user shared.
// Verifies that clicking the Download Brochure button or the Call Us Now button
// correctly fires the auto-conversion beacon.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { buildInjection } = require(path.join(__dirname, '../src/lib/autoConversion'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const ACME_PATH = path.join(__dirname, '../test-fixtures/acme-landing.html');

function loadPage({ terms, clearConvCookie = true }) {
  let html = fs.readFileSync(ACME_PATH, 'utf8');

  // Inject our auto-conversion script before </body>
  const injection = buildInjection({ terms });
  const idx = html.indexOf('</body>');
  html = html.slice(0, idx) + injection + html.slice(idx);

  // Stub the lucide CDN script so jsdom doesn't error
  html = html.replace(
    /<script src="https:\/\/unpkg\.com\/lucide[^"]*"><\/script>/,
    '<script>window.lucide={createIcons:function(){}};</script>'
  );

  // Pre-script: set bg_click cookie + stub APIs the page uses
  const preScript = `<script>
    document.cookie = 'bg_click=CLICK_TEST; path=/';
    ${clearConvCookie ? "document.cookie = 'bg_conv=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';" : ''}
    window.__beacons = [];
    navigator.sendBeacon = function(u, b) {
      b.text().then(t => { try { window.__beacons.push(JSON.parse(t)); } catch(e){} });
      return true;
    };
    window.fetch = function(u, o) {
      try { window.__beacons.push(JSON.parse(o.body)); } catch(e) {}
      return Promise.resolve({ ok: true });
    };
    // Page uses these APIs - stub minimally
    window.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} };
    if (!URL.createObjectURL) URL.createObjectURL = function(){ return 'blob:fake'; };
    if (!URL.revokeObjectURL) URL.revokeObjectURL = function(){};
  </script>`;
  html = html.replace('<head>', '<head>' + preScript);

  return new JSDOM(html, {
    url: 'https://example.com/landing',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
}

async function clickAndWait(dom, target) {
  const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  // preventDefault on the click event so jsdom doesn't try to navigate to tel:/mailto:
  target.addEventListener('click', e => e.preventDefault(), { once: true, capture: true });
  target.dispatchEvent(ev);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

(async () => {
  console.log('Acme landing page integration:');

  await test('Wait for DOMContentLoaded then verify both buttons exist', async () => {
    const dom = loadPage({ terms: ['download', 'call', 'subscribe', 'sign up'] });
    await new Promise(r => setTimeout(r, 100));     // let page scripts run
    const downloadBtn = dom.window.document.getElementById('downloadBtn');
    const callBtn = dom.window.document.querySelector('a.btn-green[href^="tel:"]');
    assert.ok(downloadBtn, 'downloadBtn missing');
    assert.ok(callBtn, 'callBtn missing');
    assert.strictEqual(callBtn.getAttribute('href'), 'tel:+18005551234');
  });

  await test('Click Download Brochure button → conversion fires for "download"', async () => {
    const dom = loadPage({ terms: ['download', 'call', 'subscribe'] });
    await new Promise(r => setTimeout(r, 100));
    const btn = dom.window.document.getElementById('downloadBtn');
    await clickAndWait(dom, btn);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 1, `expected 1 beacon, got ${beacons.length}`);
    assert.strictEqual(beacons[0].term, 'download');
    assert.match(beacons[0].text, /Download Brochure/);
    assert.match(beacons[0].element, /^a/);
  });

  await test('Click Call Us Now (tel: link) → conversion fires for "call"', async () => {
    const dom = loadPage({ terms: ['download', 'call', 'subscribe'] });
    await new Promise(r => setTimeout(r, 100));
    const btn = dom.window.document.querySelector('a.btn-green[href^="tel:"]');
    await clickAndWait(dom, btn);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 1, `expected 1 beacon, got ${beacons.length}`);
    assert.strictEqual(beacons[0].term, 'call');
    assert.strictEqual(beacons[0].href, 'tel:+18005551234');
  });

  await test('Click on the SVG icon INSIDE the Download button → still fires (ancestor walk)', async () => {
    const dom = loadPage({ terms: ['download'] });
    await new Promise(r => setTimeout(r, 100));
    const btn = dom.window.document.getElementById('downloadBtn');
    // Find a child of the button (might be SVG, span, or the i tag)
    const inner = btn.firstElementChild || btn.querySelector('*');
    assert.ok(inner, 'download button should have inner element to click');
    await clickAndWait(dom, inner);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 1, `expected 1 beacon when clicking inside, got ${beacons.length}`);
    assert.strictEqual(beacons[0].term, 'download');
  });

  await test('Click on tel: link\'s child icon → still fires as call', async () => {
    const dom = loadPage({ terms: ['download', 'call'] });
    await new Promise(r => setTimeout(r, 100));
    const btn = dom.window.document.querySelector('a.btn-green[href^="tel:"]');
    const inner = btn.firstElementChild || btn.querySelector('*');
    await clickAndWait(dom, inner);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].term, 'call');
    assert.strictEqual(beacons[0].href, 'tel:+18005551234');
  });

  await test('Footer phone link <a href="tel:...">+1 (800) 555-1234</a> also fires', async () => {
    const dom = loadPage({ terms: ['call'] });
    await new Promise(r => setTimeout(r, 100));
    const footerPhone = dom.window.document.querySelector('footer a[href^="tel:"]');
    assert.ok(footerPhone, 'footer phone link missing');
    await clickAndWait(dom, footerPhone);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].term, 'call');
  });

  await test('Click on a NON-button (the hero h1) → no conversion fires', async () => {
    const dom = loadPage({ terms: ['download', 'call'] });
    await new Promise(r => setTimeout(r, 100));
    const h1 = dom.window.document.querySelector('h1');
    await clickAndWait(dom, h1);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 0, 'should not fire for clicks on non-interactive content');
  });

  await test('Click on a stat card (number/label) → no conversion fires', async () => {
    const dom = loadPage({ terms: ['download'] });
    await new Promise(r => setTimeout(r, 100));
    const number = dom.window.document.querySelector('.stat-card .number');
    await clickAndWait(dom, number);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 0);
  });

  await test('Click on the navbar Services link → no conversion fires', async () => {
    const dom = loadPage({ terms: ['download', 'call'] });
    await new Promise(r => setTimeout(r, 100));
    const link = Array.from(dom.window.document.querySelectorAll('a'))
      .find(a => a.textContent.trim() === 'Services');
    assert.ok(link, 'Services nav link missing');
    await clickAndWait(dom, link);
    const beacons = dom.window.__beacons;
    assert.strictEqual(beacons.length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
  console.error('CRASH:', err);
  process.exit(1);
});
