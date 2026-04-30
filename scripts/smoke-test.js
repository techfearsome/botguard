// End-to-end smoke test: boots a real server against in-memory Mongo,
// exercises the /go route, the conversion pixel, the admin dashboard,
// and the ASN blacklist seed.

const { MongoMemoryServer } = require('mongodb-memory-server');
const path = require('path');

(async () => {
  const mongod = await MongoMemoryServer.create({
    binary: { version: '7.0.14' },
  });
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.PORT = '3789';
  process.env.BASE_URL = 'http://localhost:3789';
  process.env.SESSION_SECRET = 'test-secret';
  process.env.NODE_ENV = 'test';
  process.env.DEFAULT_WORKSPACE_SLUG = 'techfirio';

  // Boot the server
  require(path.join(__dirname, 'src/server.js'));

  // Wait a beat for it to bind
  await new Promise((r) => setTimeout(r, 1500));

  const BASE = 'http://localhost:3789';
  const fetch = (url, opts) => global.fetch(url, opts);

  // --- 1. Healthz
  let r = await fetch(`${BASE}/healthz`);
  console.log(`[healthz] ${r.status}  ok=${(await r.json()).ok}`);

  // --- 2. Seed campaign + landing page directly via models
  const mongoose = require('mongoose');
  const { Workspace, Campaign, LandingPage, AsnBlacklist, Click } = require(path.join(__dirname, 'src/models'));

  const ws = await Workspace.findOne({ slug: 'techfirio' });
  console.log(`[workspace] slug=${ws.slug} id=${ws._id.toString().slice(0,8)}`);

  const seedCount = await AsnBlacklist.countDocuments({});
  console.log(`[asn_blacklist] seeded entries: ${seedCount}`);

  const lp = await LandingPage.create({
    workspace_id: ws._id,
    slug: 'demo-page',
    name: 'Demo Page',
    kind: 'offer',
    html_template: '<h1>Hello {{utm_source}}!</h1><p>cid={{click_id}}</p>',
  });
  const camp = await Campaign.create({
    workspace_id: ws._id,
    slug: 'demo',
    name: 'Demo Campaign',
    status: 'active',
    source_profile: 'email',
    landing_page_id: lp._id,
    filter_config: { threshold: 70, mode: 'log_only' },
  });
  console.log(`[seed] campaign=${camp.slug}, landing=${lp.slug}`);

  // --- 3. Hit /go/demo and verify substitution + click record
  r = await fetch(`${BASE}/go/demo?utm_source=newsletter&utm_medium=email&utm_campaign=launch&fbclid=ABC123`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone) AppleWebKit Instagram 250.0.0' },
  });
  const html = await r.text();
  const cookieHeader = r.headers.get('set-cookie') || '';
  const cidMatch = cookieHeader.match(/bg_cid=([^;]+)/);
  const cid = cidMatch ? cidMatch[1] : null;
  console.log(`[/go/demo] status=${r.status}  has_substitution=${html.includes('newsletter')}  cid_set=${!!cid}`);

  // --- 4. Verify click was logged
  await new Promise((r) => setTimeout(r, 300));  // let async write complete
  const clickCount = await Click.countDocuments({ click_id: cid });
  const click = await Click.findOne({ click_id: cid }).lean();
  console.log(`[click_log] count=${clickCount}  utm_source=${click?.utm?.source}  inapp=${click?.in_app_browser}  fbclid=${click?.external_ids?.fbclid?.slice(0,6)}`);

  // --- 5. Fire a conversion pixel
  r = await fetch(`${BASE}/px/conv?cid=${cid}&value=25&event=signup`);
  console.log(`[/px/conv] status=${r.status}  type=${r.headers.get('content-type')}`);

  // --- 6. S2S postback
  r = await fetch(`${BASE}/cb/postback?cid=${cid}&value=99&event=purchase`, { method: 'POST' });
  console.log(`[/cb/postback] status=${r.status}  body=${(await r.text()).slice(0,80)}`);

  // --- 7. Admin dashboard renders
  r = await fetch(`${BASE}/admin`);
  const dash = await r.text();
  console.log(`[/admin] status=${r.status}  has_clicks=${dash.includes('Recent Clicks')}  shows_campaign=${dash.includes('newsletter')}`);

  // --- 8. ASN blacklist page
  r = await fetch(`${BASE}/admin/asn`);
  const asnPage = await r.text();
  console.log(`[/admin/asn] status=${r.status}  shows_tor=${asnPage.includes('Tor')}  shows_M247=${asnPage.includes('M247')}`);

  // --- 9. 404 for unknown campaign
  r = await fetch(`${BASE}/go/does-not-exist`);
  console.log(`[/go/unknown] status=${r.status}`);

  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
