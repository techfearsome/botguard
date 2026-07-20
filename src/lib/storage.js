/**
 * storage.js — pluggable storage backend for media uploads. One env switch
 * selects where bytes live; the /wp-content/uploads/<id>/<filename> URL is
 * identical regardless of backend.
 *
 *   UPLOAD_STORAGE = mongo | local | s3     (default: mongo)
 *
 * mongo  — bytes in the Upload document (default; survives redeploys, no infra)
 * local  — bytes on the server filesystem at UPLOAD_LOCAL_DIR
 *          ⚠ requires a PERSISTENT VOLUME mounted there, or files are wiped on
 *          redeploy (this container has no persistent fs by default).
 * s3     — any S3-compatible endpoint: AWS S3, Cloudflare R2, Backblaze B2,
 *          DigitalOcean Spaces, or a self-hosted MinIO / Garage / SeaweedFS.
 *          Set S3_FORCE_PATH_STYLE=true for most self-hosted servers.
 *
 * Env for local:
 *   UPLOAD_LOCAL_DIR=/data/uploads
 * Env for s3:
 *   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 *   S3_FORCE_PATH_STYLE=true|false
 *   S3_PUBLIC_BASE_URL   (optional) — if set, serving 302-redirects here
 *                        (e.g. a Cloudflare/CDN domain in front of the bucket);
 *                        if unset, bytes are streamed through the app.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const logger = require('./logger');

function activeBackend() {
  const v = String(process.env.UPLOAD_STORAGE || 'mongo').trim().toLowerCase();
  return ['mongo', 'local', 's3'].includes(v) ? v : 'mongo';
}

// Object key / relative path for local + s3: namespaced by workspace + id.
function buildKey(workspaceId, id, filename) {
  return `${workspaceId}/${id}/${filename}`;
}

// ── local filesystem driver ───────────────────────────────────────────────
function localDir() {
  return process.env.UPLOAD_LOCAL_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
}
function localPathFor(key) {
  // Resolve safely under localDir; reject anything that escapes it.
  const base = path.resolve(localDir());
  const full = path.resolve(base, key);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('unsafe_local_path');
  }
  return full;
}
async function localPut(key, buffer) {
  const full = localPathFor(key);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, buffer);
}
async function localDel(key) {
  try { await fsp.unlink(localPathFor(key)); } catch (_) { /* already gone */ }
}

// ── s3 driver (lazy SDK load so mongo/local users pay nothing) ─────────────
let _s3client = null;
function s3client() {
  if (_s3client) return _s3client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
  });
  return _s3client;
}
async function s3Put(key, buffer, mimetype) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3client().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}
async function s3GetStream(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await s3client().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  return out.Body; // a Node Readable stream
}
async function s3Del(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
}
function s3PublicUrl(key) {
  const base = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}/${key}` : null;
}

// ── public interface ──────────────────────────────────────────────────────

/**
 * Persist bytes to the active backend.
 * @returns {{storage, data?, storage_key?}} fields to store on the Upload doc.
 */
async function save({ workspaceId, id, filename, mimetype, buffer }) {
  const backend = activeBackend();
  if (backend === 'mongo') {
    return { storage: 'mongo', data: buffer, storage_key: null };
  }
  const key = buildKey(workspaceId, id, filename);
  if (backend === 'local') {
    await localPut(key, buffer);
    return { storage: 'local', storage_key: key };
  }
  // s3
  await s3Put(key, buffer, mimetype);
  return { storage: 's3', storage_key: key };
}

/**
 * Serve an upload doc to the HTTP response. Sets caching + content-type.
 * For s3 with S3_PUBLIC_BASE_URL, redirects; otherwise streams/sends bytes.
 * Returns true if handled, false if the object is missing (caller sends 404).
 */
async function serve(res, doc) {
  const storage = doc.storage || 'mongo';

  const setHeaders = () => {
    res.set('Content-Type', doc.mimetype || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('CDN-Cache-Control', 'public, max-age=31536000, immutable');
  };

  if (storage === 'mongo') {
    if (!doc.data) return false;
    const buf = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
    setHeaders();
    res.send(buf);
    return true;
  }

  if (storage === 'local') {
    let full;
    try { full = localPathFor(doc.storage_key); } catch (_) { return false; }
    if (!fs.existsSync(full)) return false;
    setHeaders();
    fs.createReadStream(full).pipe(res);
    return true;
  }

  // s3
  const publicUrl = s3PublicUrl(doc.storage_key);
  if (publicUrl) {
    res.redirect(302, publicUrl);
    return true;
  }
  try {
    const stream = await s3GetStream(doc.storage_key);
    if (!stream) return false;
    setHeaders();
    stream.pipe(res);
    return true;
  } catch (err) {
    logger.warn('s3_serve_failed', { key: doc.storage_key, err: err.message });
    return false;
  }
}

/** Delete the bytes for an upload doc from its backend. */
async function remove(doc) {
  const storage = doc.storage || 'mongo';
  try {
    if (storage === 'local') await localDel(doc.storage_key);
    else if (storage === 's3') await s3Del(doc.storage_key);
    // mongo: bytes live in the doc; deleting the doc removes them.
  } catch (err) {
    logger.warn('storage_remove_failed', { storage, err: err.message });
  }
}

module.exports = { activeBackend, buildKey, save, serve, remove, localPathFor, s3PublicUrl };
