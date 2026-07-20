// Unit tests for the pluggable upload storage abstraction (mongo/local/s3).
// The S3 path is tested for key + public-URL + config logic without a live
// bucket; mongo and local are exercised end-to-end (local uses a temp dir).

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const storagePath = path.resolve(__dirname, '../src/lib/storage');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// Reload the module fresh so env changes take effect on module-level reads.
function freshStorage() {
  delete require.cache[require.resolve(storagePath)];
  return require(storagePath);
}

(async () => {
  console.log('activeBackend selection:');

  await test('defaults to mongo', () => {
    delete process.env.UPLOAD_STORAGE;
    assert.strictEqual(freshStorage().activeBackend(), 'mongo');
  });
  await test('honors local / s3, rejects garbage → mongo', () => {
    process.env.UPLOAD_STORAGE = 'local'; assert.strictEqual(freshStorage().activeBackend(), 'local');
    process.env.UPLOAD_STORAGE = 's3'; assert.strictEqual(freshStorage().activeBackend(), 's3');
    process.env.UPLOAD_STORAGE = 'nonsense'; assert.strictEqual(freshStorage().activeBackend(), 'mongo');
  });

  console.log('\nkey construction:');
  await test('buildKey namespaces by workspace + id', () => {
    const s = freshStorage();
    assert.strictEqual(s.buildKey('ws1', 'id9', 'logo.png'), 'ws1/id9/logo.png');
  });

  console.log('\nmongo backend:');
  await test('save returns bytes in-doc, no key', async () => {
    process.env.UPLOAD_STORAGE = 'mongo';
    const s = freshStorage();
    const out = await s.save({ workspaceId: 'w', id: 'i', filename: 'a.png', mimetype: 'image/png', buffer: Buffer.from('X') });
    assert.strictEqual(out.storage, 'mongo');
    assert.ok(Buffer.isBuffer(out.data));
    assert.strictEqual(out.storage_key, null);
  });

  console.log('\nlocal backend (real temp dir):');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgstore-'));
  await test('save writes a file, remove deletes it', async () => {
    process.env.UPLOAD_STORAGE = 'local';
    process.env.UPLOAD_LOCAL_DIR = tmp;
    const s = freshStorage();
    const out = await s.save({ workspaceId: 'ws1', id: 'abc', filename: 'logo.png', mimetype: 'image/png', buffer: Buffer.from('PNGDATA') });
    assert.strictEqual(out.storage, 'local');
    assert.strictEqual(out.storage_key, 'ws1/abc/logo.png');
    assert.ok(fs.existsSync(path.join(tmp, 'ws1/abc/logo.png')));
    await s.remove({ storage: 'local', storage_key: out.storage_key });
    assert.ok(!fs.existsSync(path.join(tmp, 'ws1/abc/logo.png')));
  });

  await test('local path traversal is rejected', () => {
    process.env.UPLOAD_LOCAL_DIR = tmp;
    const s = freshStorage();
    assert.throws(() => s.localPathFor('../../etc/passwd'), /unsafe_local_path/);
  });

  console.log('\ns3 public URL logic:');
  await test('s3PublicUrl builds CDN url when base set, null otherwise', () => {
    process.env.UPLOAD_STORAGE = 's3';
    process.env.S3_PUBLIC_BASE_URL = 'https://cdn.example.com/';
    let s = freshStorage();
    assert.strictEqual(s.s3PublicUrl('ws1/abc/logo.png'), 'https://cdn.example.com/ws1/abc/logo.png');
    delete process.env.S3_PUBLIC_BASE_URL;
    s = freshStorage();
    assert.strictEqual(s.s3PublicUrl('ws1/abc/logo.png'), null);
  });

  console.log('\nserve() dispatch (mongo, no live s3/local needed):');
  await test('mongo serve sends the buffer with headers', async () => {
    process.env.UPLOAD_STORAGE = 'mongo';
    const s = freshStorage();
    const headers = {}; let sent = null;
    const res = { set: (k, v) => { headers[k] = v; }, send: (b) => { sent = b; }, redirect: () => {} };
    const ok = await s.serve(res, { storage: 'mongo', mimetype: 'image/png', data: Buffer.from('BYTES') });
    assert.strictEqual(ok, true);
    assert.strictEqual(sent.toString(), 'BYTES');
    assert.strictEqual(headers['Content-Type'], 'image/png');
    assert.ok(String(headers['Cache-Control']).includes('immutable'));
  });

  await test('s3 serve with public base → 302 redirect', async () => {
    process.env.UPLOAD_STORAGE = 's3';
    process.env.S3_PUBLIC_BASE_URL = 'https://cdn.example.com';
    const s = freshStorage();
    let redirectedTo = null, code = null;
    const res = { set: () => {}, send: () => {}, redirect: (c, u) => { code = c; redirectedTo = u; } };
    const ok = await s.serve(res, { storage: 's3', storage_key: 'ws1/abc/logo.png', mimetype: 'image/png' });
    assert.strictEqual(ok, true);
    assert.strictEqual(code, 302);
    assert.strictEqual(redirectedTo, 'https://cdn.example.com/ws1/abc/logo.png');
  });

  await test('missing mongo bytes → not handled (404 upstream)', async () => {
    process.env.UPLOAD_STORAGE = 'mongo';
    const s = freshStorage();
    const res = { set: () => {}, send: () => {}, redirect: () => {} };
    const ok = await s.serve(res, { storage: 'mongo', mimetype: 'image/png' /* no data */ });
    assert.strictEqual(ok, false);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
