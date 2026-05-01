// DOM-level tests for the auto-conversion injection runtime.
//
// These tests load the injected HTML into a real (jsdom) DOM, simulate clicks,
// and verify the runtime fires conversions for the patterns we care about:
//   - Plain <button>Download</button>
//   - <button>Download File</button> (substring match)
//   - <button>Download Now</button>
//   - <a href="tel:9778988634">Call 9778988634</a>
//   - <a href="tel:..."> with no "call" text (still fires)
//   - React-style <div onClick=...> with text "Subscribe"
//   - Nested <button><span>Download</span></button>
//   - <span> inside a clickable <div>
//   - SVG-icon-with-text patterns

const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const { buildInjection } = require(path.join(__dirname, '../src/lib/autoConversion'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/**
 * Build a jsdom environment with our injection script loaded, the bg_cid cookie set,
 * and fetch/sendBeacon stubbed to capture outgoing payloads.
 *
 * @param {object} opts
 * @param {string[]} opts.terms - terms passed to buildInjection
 * @param {string} opts.bodyHtml - the page's body content
 * @returns {Promise<{dom, beacons, click}>}
 */
async function setupPage({ terms, bodyHtml }) {
  const injection = buildInjection({ terms });
  // We have to set the bg_cid cookie BEFORE the runtime executes, otherwise
  // the runtime sees no click_id and bails. Use an inline <script> at the top.
  const html = `<!DOCTYPE html>
    <html><head>
      <script>
        document.cookie = 'bg_cid=CLICK_TEST_123; path=/';
        // Stub sendBeacon (jsdom doesn't implement it) - capture into window.__beacons
        window.__beacons = [];
        navigator.sendBeacon = function(url, blob) {
          // Read blob synchronously via FileReader-like trick - jsdom Blob has .text()
          blob.text().then(function(t) {
            try { window.__beacons.push({ url: url, payload: JSON.parse(t) }); }
            catch (e) { window.__beacons.push({ url: url, raw: t }); }
          });
          return true;
        };
        // Also stub fetch in case sendBeacon path doesn't run
        window.fetch = function(url, opts) {
          try {
            window.__beacons.push({ url: url, payload: JSON.parse(opts.body), via: 'fetch' });
          } catch (e) {}
          return Promise.resolve({ ok: true });
        };
      </script>
    </head>
    <body>${bodyHtml}${injection}</body></html>`;

  const dom = new JSDOM(html, {
    url: 'https://example.com/landing',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  return { dom, get beacons() { return dom.window.__beacons; } };
}

/**
 * Dispatch a click event on a target element. Wait for the runtime's microtasks
 * (sendBeacon's blob.text() returns a promise) to settle.
 *
 * preventDefault on the event prevents jsdom from trying to navigate when clicking
 * <a> tags (which it doesn't fully implement).
 */
async function clickAndWait(dom, target) {
  const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  // Pre-empt navigation: most clicks in our tests are on <a> tags. Hook into the
  // event right after dispatch so the runtime still sees a real bubbling click.
  target.addEventListener('click', (e) => e.preventDefault(), { once: true });
  target.dispatchEvent(ev);
  // Let any microtask-resolved beacons resolve
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

(async () => {
  console.log('Auto-conversion runtime (real DOM):');

  await test('Plain <button>Download</button> → fires', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download', 'submit', 'subscribe'],
      bodyHtml: '<button id="cta">Download</button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1, `expected 1 beacon, got ${beacons.length}`);
    assert.strictEqual(beacons[0].payload.term, 'download');
  });

  await test('<button>Download File</button> → matches "download"', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download'],
      bodyHtml: '<button id="cta">Download File</button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].payload.term, 'download');
    assert.strictEqual(beacons[0].payload.text, 'Download File');
  });

  await test('<button>Download Now</button> → matches "download"', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download'],
      bodyHtml: '<button id="cta">Download Now</button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].payload.text, 'Download Now');
  });

  await test('Mixed-case <button>DOWNLOAD APP</button> → matches "download"', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download'],
      bodyHtml: '<button id="cta">DOWNLOAD APP</button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].payload.term, 'download');
  });

  await test('<a href="tel:9778988634">Call 9778988634</a> → matches as call', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['call', 'download'],
      bodyHtml: '<a id="cta" href="tel:9778988634">Call 9778988634</a>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].payload.term, 'call');
    assert.strictEqual(beacons[0].payload.href, 'tel:9778988634');
  });

  await test('<a href="tel:..."> with NO "call" text → still fires (special-cased)', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['call', 'download'],
      bodyHtml: '<a id="cta" href="tel:9778988634">📞 9778988634</a>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1, 'tel: should always fire even without text match');
    assert.strictEqual(beacons[0].payload.term, 'call');
  });

  await test('React-style <div onClick> (no .onclick prop set) → still matches', async () => {
    // Simulate React's pattern: addEventListener-attached handler, .onclick remains null
    const { dom, beacons } = await setupPage({
      terms: ['subscribe'],
      bodyHtml: '<div id="cta" class="btn-primary">Subscribe Now</div>',
    });
    // Attach via addEventListener like React does
    const target = dom.window.document.getElementById('cta');
    target.addEventListener('click', () => {});      // simulate a real React handler
    await clickAndWait(dom, target);
    assert.strictEqual(beacons.length, 1, `should fire on framework-rendered <div>`);
    assert.strictEqual(beacons[0].payload.term, 'subscribe');
  });

  await test('Nested <button><span>Download</span></button> → matches via ancestor walk', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download'],
      bodyHtml: '<button id="cta"><span class="ico">Download</span></button>',
    });
    // Click the inner span - ancestor walk should find the button
    const span = dom.window.document.querySelector('#cta .ico');
    await clickAndWait(dom, span);
    assert.strictEqual(beacons.length, 1);
  });

  await test('<svg> icon next to text "Download" matches', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download'],
      bodyHtml: '<button id="cta"><svg width="16" height="16"></svg> Download File</button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1);
    // Text should be cleaned up (whitespace collapsed)
    assert.match(beacons[0].payload.text, /Download File/);
  });

  await test('Click on inner <span> of a SPA-rendered clickable div → matches', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['get started'],
      bodyHtml: '<div id="cta" class="btn"><span>Get Started</span></div>',
    });
    const span = dom.window.document.querySelector('#cta span');
    await clickAndWait(dom, span);
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].payload.term, 'get started');
  });

  await test('Non-matching button does NOT fire', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download', 'subscribe'],
      bodyHtml: '<button id="other">Learn More</button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('other'));
    assert.strictEqual(beacons.length, 0);
  });

  await test('Second click after first match is ignored (session dedup)', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download'],
      bodyHtml: '<button id="cta">Download</button><button id="cta2">Download</button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    await clickAndWait(dom, dom.window.document.getElementById('cta2'));
    assert.strictEqual(beacons.length, 1, 'second click should be deduped');
  });

  await test('Phone link with extra wrapping <span> still matches via ancestor walk', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['call'],
      bodyHtml: '<a id="cta" href="tel:5551234"><span class="phone-icon"></span><span>5551234</span></a>',
    });
    const inner = dom.window.document.querySelector('.phone-icon');
    await clickAndWait(dom, inner);
    assert.strictEqual(beacons.length, 1);
    assert.strictEqual(beacons[0].payload.href, 'tel:5551234');
  });

  await test('Whitespace-rich text "  Download   File  " is collapsed and matched', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download file'],
      bodyHtml: '<button id="cta">  Download   File  </button>',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1, 'collapsed whitespace should still match "download file"');
  });

  await test('Input button: <input type="button" value="Place Order">', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['place order'],
      bodyHtml: '<input id="cta" type="button" value="Place Order">',
    });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 1);
  });

  await test('Click before bg_cid cookie set → does NOT fire', async () => {
    const { dom, beacons } = await setupPage({
      terms: ['download'],
      bodyHtml: '<button id="cta">Download</button>',
    });
    // Wipe the click cookie
    dom.window.document.cookie = 'bg_cid=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(beacons.length, 0, 'should not fire without click_id attribution');
  });

  await test('bg_conv matching current bg_cid → script bails (already converted on this click)', async () => {
    // bg_conv now stores the click_id it was set for. Bail only when it matches.
    const injection = buildInjection({ terms: ['download'] });
    const html = `<!DOCTYPE html><html><head>
      <script>
        document.cookie = 'bg_cid=CLICK_X; path=/';
        document.cookie = 'bg_conv=CLICK_X; path=/';      // matches → dedup
        window.__beacons = [];
        navigator.sendBeacon = function() { window.__beacons.push({}); return true; };
        window.fetch = function() { window.__beacons.push({}); return Promise.resolve({}); };
      </script>
    </head><body>
      <button id="cta">Download</button>
      ${injection}
    </body></html>`;
    const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'dangerously' });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(dom.window.__beacons.length, 0, 'should bail when bg_conv matches current bg_cid');
  });

  await test('bg_conv from different click_id → script DOES fire (fresh ad click)', async () => {
    // This is the critical fix: stale bg_conv from a previous ad campaign must
    // NOT block conversion on a new click_id.
    const injection = buildInjection({ terms: ['download'] });
    const html = `<!DOCTYPE html><html><head>
      <script>
        document.cookie = 'bg_cid=CLICK_NEW; path=/';
        document.cookie = 'bg_conv=CLICK_OLD; path=/';    // does NOT match → fire
        window.__beacons = [];
        navigator.sendBeacon = function(u, b) {
          b.text().then(t => { try { window.__beacons.push(JSON.parse(t)); } catch(e){} });
          return true;
        };
        window.fetch = function(u, o) { try { window.__beacons.push(JSON.parse(o.body)); } catch(e){} return Promise.resolve({ok: true}); };
      </script>
    </head><body>
      <button id="cta">Download</button>
      ${injection}
    </body></html>`;
    const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'dangerously' });
    await clickAndWait(dom, dom.window.document.getElementById('cta'));
    assert.strictEqual(dom.window.__beacons.length, 1, 'should fire on fresh click_id even when bg_conv exists');
    assert.strictEqual(dom.window.__beacons[0].click_id, 'CLICK_NEW');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('CRASH:', err);
  process.exit(1);
});
