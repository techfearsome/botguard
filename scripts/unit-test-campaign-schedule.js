// Unit tests for campaignSchedule.isInSchedule — verifies that:
// 1. Disabled schedule → always in schedule (campaign runs 24/7)
// 2. Empty rules + enabled → always out of schedule (always paused)
// 3. Normal window matching (e.g. 08:00–17:00 on Monday)
// 4. Cross-midnight window (20:30–00:00)
// 5. Multiple rules, only one needs to match
// 6. Timezone-aware (same UTC moment is in/out depending on timezone)
// 7. Manual pause is handled upstream, not here

const assert = require('assert');
const path = require('path');
const { isInSchedule, dateInTimezone, parseTime } = require(path.resolve(__dirname, '../src/lib/campaignSchedule'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('isInSchedule:');

test('disabled schedule → inSchedule=true (runs 24/7)', () => {
  assert.strictEqual(isInSchedule({ enabled: false, rules: [] }).inSchedule, true);
  assert.strictEqual(isInSchedule(null).inSchedule, true);
  assert.strictEqual(isInSchedule(undefined).inSchedule, true);
});

test('enabled + no rules → inSchedule=false (always paused)', () => {
  assert.strictEqual(isInSchedule({ enabled: true, timezone: 'UTC', rules: [] }).inSchedule, false);
});

test('matching window on correct day → inSchedule=true', () => {
  // Wednesday 2026-08-12 at 10:00 UTC
  const wed10am = new Date('2026-08-12T10:00:00Z');
  const sched = { enabled: true, timezone: 'UTC', rules: [
    { day: 3, start: '08:00', end: '17:00' },  // Wed 08:00–17:00 UTC
  ]};
  assert.strictEqual(isInSchedule(sched, wed10am).inSchedule, true);
});

test('outside window on correct day → inSchedule=false', () => {
  const wed18 = new Date('2026-08-12T18:00:00Z');
  const sched = { enabled: true, timezone: 'UTC', rules: [
    { day: 3, start: '08:00', end: '17:00' },
  ]};
  assert.strictEqual(isInSchedule(sched, wed18).inSchedule, false);
});

test('wrong day → inSchedule=false', () => {
  const thu10 = new Date('2026-08-13T10:00:00Z'); // Thursday
  const sched = { enabled: true, timezone: 'UTC', rules: [
    { day: 3, start: '08:00', end: '17:00' },  // Wednesday only
  ]};
  assert.strictEqual(isInSchedule(sched, thu10).inSchedule, false);
});

test('end at midnight (20:30–00:00) → in schedule at 21:00', () => {
  const wed21 = new Date('2026-08-12T21:00:00Z');
  const sched = { enabled: true, timezone: 'UTC', rules: [
    { day: 3, start: '20:30', end: '00:00' },
  ]};
  assert.strictEqual(isInSchedule(sched, wed21).inSchedule, true);
});

test('end at midnight (20:30–00:00) → out of schedule at 20:00', () => {
  const wed20 = new Date('2026-08-12T20:00:00Z');
  const sched = { enabled: true, timezone: 'UTC', rules: [
    { day: 3, start: '20:30', end: '00:00' },
  ]};
  assert.strictEqual(isInSchedule(sched, wed20).inSchedule, false);
});

test('multiple rules — any match is sufficient', () => {
  const sat14 = new Date('2026-08-15T14:00:00Z'); // Saturday
  const sched = { enabled: true, timezone: 'UTC', rules: [
    { day: 3, start: '08:00', end: '17:00' },  // Wed — no match
    { day: 6, start: '12:00', end: '18:00' },  // Sat — match
  ]};
  assert.strictEqual(isInSchedule(sched, sat14).inSchedule, true);
});

test('timezone-aware: 10:00 UTC is 15:30 IST', () => {
  // Wed 10:00 UTC = Wed 15:30 IST
  const wed10utc = new Date('2026-08-12T10:00:00Z');
  // Rule says Wed 15:00–16:00 IST → should match in IST, not in UTC
  const schedIST = { enabled: true, timezone: 'Asia/Kolkata', rules: [
    { day: 3, start: '15:00', end: '16:00' },
  ]};
  assert.strictEqual(isInSchedule(schedIST, wed10utc).inSchedule, true);

  // Same rule in UTC → 10:00 is NOT in 15:00–16:00 UTC
  const schedUTC = { enabled: true, timezone: 'UTC', rules: [
    { day: 3, start: '15:00', end: '16:00' },
  ]};
  assert.strictEqual(isInSchedule(schedUTC, wed10utc).inSchedule, false);
});

console.log('\ndateInTimezone:');

test('returns correct day and minutes for UTC', () => {
  const d = new Date('2026-08-12T14:30:00Z'); // Wed 14:30 UTC
  const { day, minutes } = dateInTimezone(d, 'UTC');
  assert.strictEqual(day, 3); // Wednesday
  assert.strictEqual(minutes, 14 * 60 + 30);
});

test('returns correct day and minutes for IST (UTC+5:30)', () => {
  const d = new Date('2026-08-12T20:00:00Z'); // Wed 20:00 UTC = Thu 01:30 IST
  const { day, minutes } = dateInTimezone(d, 'Asia/Kolkata');
  assert.strictEqual(day, 4); // Thursday in IST
  assert.strictEqual(minutes, 1 * 60 + 30);
});

console.log('\nparseTime:');

test('parses HH:MM to minutes', () => {
  assert.strictEqual(parseTime('00:00'), 0);
  assert.strictEqual(parseTime('20:30'), 20 * 60 + 30);
  assert.strictEqual(parseTime('23:59'), 23 * 60 + 59);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
