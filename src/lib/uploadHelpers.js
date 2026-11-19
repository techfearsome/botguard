/**
 * uploadHelpers.js — pure helpers for the media uploader: allowed types,
 * filename sanitization, and extension/content-type mapping. Kept separate so
 * they can be unit-tested without Express or Mongo.
 */

'use strict';

// Accepted upload types, keyed by the MIME the browser reports, mapped to the
// canonical extension we store/serve. Raster images, plus SVG, ICO, and WAV
// audio. SVG can carry embedded scripts (stored-XSS when served from your own
// domain), so it is served with a locked-down CSP + sandbox in storage.serve().
const ALLOWED = {
  // raster images
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // vector / icon
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  // audio
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
};

// Canonical MIME per extension. Used to (a) force a safe, correct Content-Type
// regardless of what the browser reported, and (b) accept files whose browser
// MIME is vague (e.g. application/octet-stream for .wav or .ico) by falling
// back to the filename extension.
const EXT_CANONICAL_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  wav: 'audio/wav',
};

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — safely under Mongo's 16 MB doc limit

function isAllowedMime(mimetype) {
  return Object.prototype.hasOwnProperty.call(ALLOWED, String(mimetype || '').toLowerCase());
}

function extForMime(mimetype) {
  return ALLOWED[String(mimetype || '').toLowerCase()] || null;
}

// Extract a lowercase extension from a filename (no dot), or '' if none.
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * Resolve a canonical type for an uploaded file. Prefers the reported MIME;
 * if that isn't a recognized allowed type, falls back to the filename
 * extension. Returns { ok, mime, ext } — mime/ext are canonical (so what we
 * store and serve is correct even when the browser lies or is vague).
 */
function resolveType(mimetype, originalname) {
  const mt = String(mimetype || '').toLowerCase().split(';')[0].trim();
  if (Object.prototype.hasOwnProperty.call(ALLOWED, mt)) {
    const ext = ALLOWED[mt];
    return { ok: true, mime: EXT_CANONICAL_MIME[ext] || mt, ext };
  }
  const rawExt = extOf(originalname);
  if (Object.prototype.hasOwnProperty.call(EXT_CANONICAL_MIME, rawExt)) {
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    return { ok: true, mime: EXT_CANONICAL_MIME[rawExt], ext };
  }
  return { ok: false, mime: null, ext: null };
}

// multer fileFilter predicate: accept by MIME or by known extension.
function isAllowedUpload(file) {
  return !!(file && resolveType(file.mimetype, file.originalname).ok);
}

// Sanitize a user-supplied filename into something safe for a URL path: strip
// directory parts, keep [a-z0-9-_], collapse the rest to '-', and force the
// extension to match the detected mimetype so the URL/content-type can't lie.
function sanitizeFilename(name, mimetype) {
  const ext = extForMime(mimetype) || 'bin';
  let base = String(name || 'file')
    .replace(/^.*[\\/]/, '')          // strip any path
    .replace(/\.[^.]*$/, '')          // strip existing extension
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')    // safe chars only
    .replace(/^-+|-+$/g, '')          // trim dashes
    .slice(0, 60);
  if (!base) base = 'file';
  return `${base}.${ext}`;
}

// Build the public URL for an upload.
function publicUrl(id, filename) {
  return `/wp-content/uploads/${id}/${filename}`;
}

module.exports = {
  ALLOWED, MAX_BYTES, EXT_CANONICAL_MIME,
  isAllowedMime, isAllowedUpload, resolveType,
  extForMime, extOf, sanitizeFilename, publicUrl,
};
