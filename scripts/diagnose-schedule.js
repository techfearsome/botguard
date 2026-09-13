// Schedule diagnostic — run this INSIDE your container:
//   node scripts/diagnose-schedule.js
//
// It reports, for every campaign with a schedule enabled:
//   - what's stored in Mongo
//   - what the checker says RIGHT NOW
//   - whether the deployed go.js has the correct gate order
// This tells us definitively where the problem is.

const path = require('path');
const fs = require('fs');

(async () => {
  console.log('='.repeat(70));
  console.log('BOTGUARD SCHEDULE DIAGNOSTIC');
  console.log('='.repeat(70));

  // ── 1. Check the deployed go.js gate order ──────────────────────────────
  console.log('\n[1] DEPLOYED CODE CHECK');
  const goPath = path.resolve(__dirname, '../src/routes/go.js');
  const goSrc = fs.readFileSync(goPath, 'utf8');

  const schedIdx = goSrc.indexOf('ad_schedule && campaign.ad_schedule.enabled');
  const pauseIdx = goSrc.indexOf("campaign.status === 'paused'");
  const hasFirstComment = goSrc.includes('runs FIRST when enabled');

  console.log('  schedule gate found at char:', schedIdx === -1 ? 'NOT FOUND ❌' : schedIdx);
  console.log('  pause gate found at char   :', pauseIdx === -1 ? 'NOT FOUND ❌' : pauseIdx);
  console.log('  has "runs FIRST" comment   :', hasFirstComment ? 'YES ✓' : 'NO ❌ (old version deployed)');

  if (schedIdx === -1) {
    console.log('\n  ❌ PROBLEM: The schedule gate is NOT in the deployed go.js.');
    console.log('     → Deploy src/routes/go.js from the latest patch.');
  } else if (pauseIdx !== -1 && pauseIdx < schedIdx) {
    console.log('\n  ❌ PROBLEM: The PAUSE gate comes BEFORE the schedule gate.');
    console.log('     → You have the OLD version. A paused campaign will never');
    console.log('       reach the schedule check. Deploy the latest go.js.');
  } else {
    console.log('\n  ✓ Gate order is correct (schedule before pause).');
  }

  // ── 2. Check campaignSchedule.js exists ────────────────────────────────
  console.log('\n[2] SCHEDULE LIB CHECK');
  const libPath = path.resolve(__dirname, '../src/lib/campaignSchedule.js');
  if (!fs.existsSync(libPath)) {
    console.log('  ❌ src/lib/campaignSchedule.js NOT FOUND — deploy it.');
    process.exit(1);
  }
  console.log('  ✓ campaignSchedule.js present');

  const { isInSchedule, dateInTimezone } = require(libPath);

  // ── 3. Check stored data + live evaluation ─────────────────────────────
  console.log('\n[3] CAMPAIGN DATA + LIVE EVALUATION');
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const Campaign = require(path.resolve(__dirname, '../src/models/Campaign'));

  const camps = await Campaign.find({ 'ad_schedule.enabled': true })
    .select('name slug root_path status ad_schedule').lean();

  if (camps.length === 0) {
    console.log('  ⚠ No campaigns have ad_schedule.enabled = true.');
    console.log('    → Enable the schedule on a campaign and save it.');
  }

  const now = new Date();
  console.log('  Server time (UTC):', now.toISOString());

  for (const c of camps) {
    const sched = c.ad_schedule;
    const tz = sched.timezone || 'UTC';
    const dt = dateInTimezone(now, tz);
    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.day];
    const hhmm = String(Math.floor(dt.minutes / 60)).padStart(2, '0') + ':' + String(dt.minutes % 60).padStart(2, '0');
    const result = isInSchedule(sched, now);

    console.log('\n  ── ' + c.name + ' (' + (c.root_path ? '/' + c.root_path : '/go/' + c.slug) + ')');
    console.log('     DB status      :', c.status);
    console.log('     Timezone       :', tz);
    console.log('     Now in that TZ :', dayName + ' ' + hhmm + '  (day=' + dt.day + ', minutes=' + dt.minutes + ')');
    console.log('     Rules          :', JSON.stringify((sched.rules || []).map(r => ({ day: r.day, start: r.start, end: r.end }))));
    console.log('     → isInSchedule :', JSON.stringify(result));
    console.log('     → EXPECTED     :', result.inSchedule
      ? 'Campaign should SERVE the offer page'
      : 'Campaign should show the SAFE page');
  }

  console.log('\n' + '='.repeat(70));
  console.log('Compare the EXPECTED result above with what you see in a browser.');
  console.log('If they match, the scheduler works. If not, paste this output.');
  console.log('='.repeat(70));

  process.exit(0);
})().catch((e) => {
  console.error('DIAGNOSTIC FAILED:', e.message);
  process.exit(1);
});
