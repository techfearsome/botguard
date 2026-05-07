// Integration tests for the firewall ledger - the recordFirewallEntry()
// helper that creates/updates FirewallEntry rows from the click write path.
//
// We don't spin up real Mongo for this. Instead we replace FirewallEntry
// in require.cache with a tiny in-memory fake that records the upsert
// operations so we can assert what the recorder would have written.
//
// What this proves:
//   1. Allowed clicks do NOT produce a firewall entry
//   2. Excluded reasons (country, UTM gates) do NOT produce an entry
//   3. Fraud reasons (proxy, vpn, datacenter, bot) DO produce an entry
//   4. Repeat hits accumulate reasons + reason_classes via $addToSet
//   5. hit_count increments via $inc
//   6. last_seen + last_* fields are set fresh on every hit
//   7. Recorder errors don't throw (fire-and-forget contract)

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// In-memory FirewallEntry stub. Tracks every updateOne call so tests can
// inspect what the recorder did. Also exposes the real classify() helper
// so the recorder works (it imports classify off the model).
const calls = [];
const FirewallEntryStub = {
  updateOne: async (filter, update, options) => {
    calls.push({ filter, update, options });
    return { upsertedId: 'fake-id', matchedCount: 1 };
  },
  classify: require(path.resolve(__dirname, '../src/models/FirewallEntry')).classify,
  REASON_CLASSES: require(path.resolve(__dirname, '../src/models/FirewallEntry')).REASON_CLASSES,
};
require.cache[require.resolve(path.resolve(__dirname, '../src/models/FirewallEntry'))] = {
  exports: FirewallEntryStub, loaded: true, id: '', filename: '',
};

// Now require the recorder fresh - it'll use our stubbed FirewallEntry.
delete require.cache[require.resolve(path.resolve(__dirname, '../src/lib/firewall'))];
const { recordFirewallEntry } = require(path.resolve(__dirname, '../src/lib/firewall'));

function reset() { calls.length = 0; }
function lastCall() { return calls[calls.length - 1]; }

async function run() {
  console.log('recordFirewallEntry - exclusion paths:');

  await test('Skips when click is null', async () => {
    reset();
    await recordFirewallEntry(null);
    assert.strictEqual(calls.length, 0);
  });

  await test('Skips when ip is missing', async () => {
    reset();
    await recordFirewallEntry({ workspace_id: 'ws1', decision: 'block', decision_reason: 'proxy_gate:vpn' });
    assert.strictEqual(calls.length, 0);
  });

  await test('Skips when workspace_id is missing', async () => {
    reset();
    await recordFirewallEntry({ ip: '1.2.3.4', decision: 'block', decision_reason: 'proxy_gate:vpn' });
    assert.strictEqual(calls.length, 0);
  });

  await test('Skips allowed clicks', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'allow', decision_reason: 'allow',
    });
    assert.strictEqual(calls.length, 0);
  });

  await test('Skips country_gate blocks', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'country_gate:not_in_allowlist',
    });
    assert.strictEqual(calls.length, 0,
      'country_gate is a policy decision, not a fraud signal - must not be recorded');
  });

  await test('Skips utm_gate blocks (high false positive rate)', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'utm_gate:missing_source',
    });
    assert.strictEqual(calls.length, 0);
  });

  await test('Skips campaign_paused', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'campaign_paused',
    });
    assert.strictEqual(calls.length, 0);
  });

  console.log('\nrecordFirewallEntry - recording fraud signals:');

  await test('Records proxy_gate:vpn block', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'proxy_gate:vpn',
      device_label: 'iphone', country: 'US', user_agent: 'Mozilla/5.0',
      campaign_slug: 'main-promo',
    }, { asn: 'NordVPN' });
    assert.strictEqual(calls.length, 1);
    const c = lastCall();
    assert.deepStrictEqual(c.filter, { workspace_id: 'ws1', ip: '1.2.3.4' });
    assert.strictEqual(c.options.upsert, true);
    assert.strictEqual(c.update.$setOnInsert.workspace_id, 'ws1');
    assert.strictEqual(c.update.$setOnInsert.ip, '1.2.3.4');
    assert.deepStrictEqual(c.update.$inc, { hit_count: 1 });
    assert.deepStrictEqual(c.update.$addToSet.reason_classes, 'proxy');
    assert.strictEqual(c.update.$set.last_country, 'US');
    assert.strictEqual(c.update.$set.last_asn, 'NordVPN');
    assert.strictEqual(c.update.$set.last_device, 'iphone');
    assert.strictEqual(c.update.$set.last_campaign_slug, 'main-promo');
  });

  await test('Records would_block (log-only mode) entries too', async () => {
    // log_only mode is for testing - the click was scored as block but
    // the visitor was allowed through. We still want to record the IP
    // so admins can review what the chain would have caught.
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'would_block', decision_reason: 'proxy_gate:proxy',
    });
    assert.strictEqual(calls.length, 1, 'would_block not recorded - log_only mode loses visibility');
  });

  await test('Records datacenter as separate class from proxy', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'proxy_gate:datacenter',
    });
    const c = lastCall();
    assert.strictEqual(c.update.$addToSet.reason_classes, 'datacenter');
  });

  await test('Records bot detection from threshold scorer', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'threshold:85>=70',
    });
    const c = lastCall();
    assert.strictEqual(c.update.$addToSet.reason_classes, 'bot');
  });

  await test('Records hard_block hits', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'hard_block:headless',
    });
    const c = lastCall();
    assert.strictEqual(c.update.$addToSet.reason_classes, 'hard_block');
  });

  await test('Caps user_agent at 500 chars', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'proxy_gate:vpn',
      user_agent: 'X'.repeat(2000),
    });
    const c = lastCall();
    assert.strictEqual(c.update.$set.last_user_agent.length, 500);
  });

  await test('Stores raw decision_reason in reasons array via $addToSet', async () => {
    reset();
    await recordFirewallEntry({
      workspace_id: 'ws1', ip: '1.2.3.4',
      decision: 'block', decision_reason: 'proxy_gate:vpn',
    });
    const c = lastCall();
    // $addToSet with $each is the idempotent-add idiom
    assert.deepStrictEqual(c.update.$addToSet.reasons, { $each: ['proxy_gate:vpn'] });
  });

  console.log('\nrecordFirewallEntry - error handling:');

  await test('Does not throw if Mongo write fails', async () => {
    reset();
    // Replace updateOne with one that throws
    const orig = FirewallEntryStub.updateOne;
    FirewallEntryStub.updateOne = async () => { throw new Error('DB down'); };
    try {
      await recordFirewallEntry({
        workspace_id: 'ws1', ip: '1.2.3.4',
        decision: 'block', decision_reason: 'proxy_gate:vpn',
      });
      // If we get here, it didn't throw - good
    } finally {
      FirewallEntryStub.updateOne = orig;
    }
  });

  await test('Recovers from duplicate-key race', async () => {
    reset();
    let firstCall = true;
    const orig = FirewallEntryStub.updateOne;
    FirewallEntryStub.updateOne = async (filter, update) => {
      if (firstCall) {
        firstCall = false;
        const e = new Error('E11000 duplicate key');
        e.code = 11000;
        throw e;
      }
      // Second call (the retry) succeeds with simpler update
      calls.push({ filter, update, retry: true });
      return { matchedCount: 1 };
    };
    try {
      await recordFirewallEntry({
        workspace_id: 'ws1', ip: '1.2.3.4',
        decision: 'block', decision_reason: 'proxy_gate:vpn',
      });
      // Verify retry happened
      const retryCall = calls.find((c) => c.retry);
      assert.ok(retryCall, 'retry was not made after duplicate-key error');
      assert.deepStrictEqual(retryCall.filter, { workspace_id: 'ws1', ip: '1.2.3.4' });
    } finally {
      FirewallEntryStub.updateOne = orig;
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
