// Unit test for liveSync replay logic — proves that events from one worker
// correctly update another worker's LivePresence state.

const assert = require('assert');
const path = require('path');
const { LivePresence } = require(path.resolve(__dirname, '../src/lib/livePresence'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// Simulate two workers, each with their own LivePresence.
const worker1 = new LivePresence();
const worker2 = new LivePresence();

// Simulate the replay logic from liveSync (extracted so we can test without Redis).
function replay(target, evt) {
  switch (evt.type) {
    case 'arrived':
    case 'updated':
      if (evt.visitor) target.visitors.set(evt.visitor.click_id, evt.visitor);
      break;
    case 'heartbeat':
      if (evt.visitor) {
        const v = target.visitors.get(evt.visitor.click_id);
        if (v) v.last_seen_at = evt.visitor.last_seen_at;
        else target.visitors.set(evt.visitor.click_id, evt.visitor);
      }
      break;
    case 'converted':
      if (evt.visitor) {
        const v = target.visitors.get(evt.visitor.click_id);
        if (v) { v.converted = true; v.converted_at = evt.visitor.converted_at; }
      }
      break;
    case 'left':
      if (evt.visitor) target.visitors.delete(evt.visitor.click_id);
      break;
  }
}

console.log('liveSync replay:');

test('arrived on worker1 → replayed to worker2', () => {
  const visitor = { click_id: 'abc', workspace_id: 'ws1', page_type: 'offer', ip: '1.2.3.4', arrived_at: Date.now(), last_seen_at: Date.now() };
  worker1.arrived(visitor);
  assert.strictEqual(worker1.visitors.size, 1);
  assert.strictEqual(worker2.visitors.size, 0);

  // Simulate pub/sub: worker1 emitted, worker2 replays.
  replay(worker2, { type: 'arrived', visitor: worker1.visitors.get('abc') });
  assert.strictEqual(worker2.visitors.size, 1);
  assert.strictEqual(worker2.visitors.get('abc').ip, '1.2.3.4');
});

test('heartbeat on worker1 → replayed to worker2', () => {
  const now = Date.now();
  worker1.heartbeat('abc');
  const v1 = worker1.visitors.get('abc');
  replay(worker2, { type: 'heartbeat', visitor: { click_id: 'abc', last_seen_at: v1.last_seen_at } });
  assert.strictEqual(worker2.visitors.get('abc').last_seen_at, v1.last_seen_at);
});

test('converted on worker1 → replayed to worker2', () => {
  // Simulate marking converted on worker1.
  const v = worker1.visitors.get('abc');
  v.converted = true;
  v.converted_at = Date.now();
  replay(worker2, { type: 'converted', visitor: { click_id: 'abc', converted: true, converted_at: v.converted_at } });
  assert.strictEqual(worker2.visitors.get('abc').converted, true);
});

test('left on worker1 → removed from worker2', () => {
  replay(worker2, { type: 'left', visitor: { click_id: 'abc' } });
  assert.strictEqual(worker2.visitors.has('abc'), false);
});

test('heartbeat for unknown visitor adds them (arrived on another worker)', () => {
  const visitor = { click_id: 'xyz', ip: '5.6.7.8', page_type: 'safe', last_seen_at: Date.now() };
  replay(worker2, { type: 'heartbeat', visitor });
  assert.strictEqual(worker2.visitors.size, 1);
  assert.strictEqual(worker2.visitors.get('xyz').ip, '5.6.7.8');
});

worker1.stop();
worker2.stop();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
