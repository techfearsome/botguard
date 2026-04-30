// Auth unit tests - password hashing, session signing/verification.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars-long';

const assert = require('assert');
const path = require('path');
const { hashPassword, verifyPassword, signSession, verifySession } = require(path.join(__dirname, '../src/middleware/auth'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('Password hashing:');

test('hashPassword produces salt:hash format', () => {
  const h = hashPassword('hunter2');
  assert.ok(h.includes(':'));
  const [salt, hash] = h.split(':');
  assert.strictEqual(salt.length, 32);     // 16 bytes hex
  assert.strictEqual(hash.length, 128);    // 64 bytes hex
});

test('verifyPassword accepts correct password', () => {
  const h = hashPassword('correct horse battery staple');
  assert.strictEqual(verifyPassword('correct horse battery staple', h), true);
});

test('verifyPassword rejects wrong password', () => {
  const h = hashPassword('hunter2');
  assert.strictEqual(verifyPassword('hunter3', h), false);
});

test('verifyPassword rejects empty inputs safely', () => {
  assert.strictEqual(verifyPassword('', 'a:b'), false);
  assert.strictEqual(verifyPassword('x', ''), false);
  assert.strictEqual(verifyPassword(null, null), false);
});

test('verifyPassword rejects malformed hash', () => {
  assert.strictEqual(verifyPassword('test', 'not-a-real-hash'), false);
  assert.strictEqual(verifyPassword('test', 'just_one_part'), false);
});

test('Two hashes of same password produce different output (salted)', () => {
  const h1 = hashPassword('same');
  const h2 = hashPassword('same');
  assert.notStrictEqual(h1, h2);
  // But both verify
  assert.strictEqual(verifyPassword('same', h1), true);
  assert.strictEqual(verifyPassword('same', h2), true);
});

console.log('\nSession signing:');

test('signSession produces 3-part token', () => {
  const token = signSession('admin');
  const parts = token.split('.');
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0], 'admin');
});

test('verifySession returns username for valid token', () => {
  const token = signSession('admin');
  const session = verifySession(token);
  assert.ok(session);
  assert.strictEqual(session.username, 'admin');
});

test('verifySession rejects tampered username', () => {
  const token = signSession('admin');
  const parts = token.split('.');
  parts[0] = 'evil';
  const tampered = parts.join('.');
  assert.strictEqual(verifySession(tampered), null);
});

test('verifySession rejects tampered timestamp', () => {
  const token = signSession('admin');
  const parts = token.split('.');
  parts[1] = String(Date.now() + 1000);
  const tampered = parts.join('.');
  assert.strictEqual(verifySession(tampered), null);
});

test('verifySession rejects malformed tokens', () => {
  assert.strictEqual(verifySession(null), null);
  assert.strictEqual(verifySession(''), null);
  assert.strictEqual(verifySession('only-one-part'), null);
  assert.strictEqual(verifySession('two.parts'), null);
  assert.strictEqual(verifySession('a.b.c.d'), null);
});

test('verifySession rejects expired tokens', () => {
  // Forge a token with a timestamp 8 days ago
  const crypto = require('crypto');
  const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const payload = `admin.${oldTs}`;
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
  const token = `${payload}.${sig}`;
  assert.strictEqual(verifySession(token), null);
});

test('Tokens signed with different secret are rejected', () => {
  const token = signSession('admin');
  // Change the secret and try to verify
  const original = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a-different-secret-also-long-enough';
  try {
    assert.strictEqual(verifySession(token), null);
  } finally {
    process.env.SESSION_SECRET = original;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
