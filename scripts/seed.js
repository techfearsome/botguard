// Seeds a sample campaign + landing page for quick testing.
// Run: node scripts/seed.js

require('dotenv').config();
const mongoose = require('mongoose');
const { ensureDefaultWorkspace, DEFAULT_SLUG } = require('../src/lib/bootstrap');
const { Workspace, Campaign, LandingPage } = require('../src/models');

const SAMPLE_OFFER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sample Offer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; }
    .cta { display: inline-block; padding: 14px 28px; background: #2d6cdf; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .meta { color: #888; font-size: 13px; margin-top: 40px; }
  </style>
</head>
<body>
  <h1>Welcome to our offer</h1>
  <p>This is a sample landing page. The click ID is automatically captured for attribution.</p>
  <p><a href="/px/conv?cid={{click_id}}&value=10" class="cta">Convert (test)</a></p>
  <div class="meta">
    Click ID: {{click_id}}<br>
    Source: {{utm_source}} / {{utm_medium}} / {{utm_campaign}}
  </div>
</body>
</html>`;

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/botguard');
  await ensureDefaultWorkspace();

  const ws = await Workspace.findOne({ slug: DEFAULT_SLUG });

  let lp = await LandingPage.findOne({ workspace_id: ws._id, slug: 'sample-offer' });
  if (!lp) {
    lp = await LandingPage.create({
      workspace_id: ws._id,
      slug: 'sample-offer',
      name: 'Sample Offer',
      kind: 'offer',
      html_template: SAMPLE_OFFER_HTML,
    });
    console.log('Created landing page:', lp.slug);
  }

  let camp = await Campaign.findOne({ workspace_id: ws._id, slug: 'demo' });
  if (!camp) {
    camp = await Campaign.create({
      workspace_id: ws._id,
      slug: 'demo',
      name: 'Demo Campaign',
      status: 'active',
      source_profile: 'mixed',
      landing_page_id: lp._id,
      filter_config: { threshold: 70, mode: 'log_only' },
    });
    console.log('Created campaign:', camp.slug);
  }

  console.log(`\nReady. Try: ${process.env.BASE_URL || 'http://localhost:3000'}/go/demo?utm_source=test&utm_medium=email&utm_campaign=launch`);
  console.log(`Admin:  ${process.env.BASE_URL || 'http://localhost:3000'}/admin`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
