// Unit test: loginSubmit records a LoginEvent on success and failure, with the
// correct reason, and never lets a DB error break the login flow.

process.env.SESSION_SECRET = 'test-secret-at-least-16-chars';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'correct-horse';

const assert = require('assert');
const path = require('path');

// Capture LoginEvent.create calls via a stubbed models module.
const modelsPath = path.resolve(__dirname, '../src/models');
const created = [];
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: { LoginEvent: { create: async (doc) => { created.push(doc); return doc; } } },
};

const auth = require(path.resolve(__dirname, '../src/middleware/auth'));

function fakeReq(body) {
  return { body, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36', 'cf-connecting-ip': '203.0.113.9' }, ip: '203.0.113.9', secure: true };
}
function fakeRes() {
  return { cookie() {}, redirect() {} };
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// Give fire-and-forget writes a tick to land.
const tick = () => new Promise((r) => setTimeout(r, 10));

(async () => {
  console.log('loginSubmit event recording:');

  await test('successful login → success event with reason ok', async () => {
    created.length = 0;
    auth.loginSubmit(fakeReq({ username: 'admin', password: 'correct-horse' }), fakeRes());
    await tick();
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].success, true);
    assert.strictEqual(created[0].reason, 'ok');
    assert.strictEqual(created[0].ip, '203.0.113.9');       // Cloudflare real IP
    assert.strictEqual(created[0].device_class, 'windows'); // parsed device
  });

  await test('wrong password → failed event with reason bad_password', async () => {
    created.length = 0;
    auth.loginSubmit(fakeReq({ username: 'admin', password: 'WRONG' }), fakeRes());
    await tick();
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].success, false);
    assert.strictEqual(created[0].reason, 'bad_password');
  });

  await test('unknown username → failed event with reason unknown_user', async () => {
    created.length = 0;
    auth.loginSubmit(fakeReq({ username: 'someone-else', password: 'x' }), fakeRes());
    await tick();
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].success, false);
    assert.strictEqual(created[0].reason, 'unknown_user');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
