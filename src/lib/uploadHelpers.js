/**
 * uploadHelpers.js — pure helpers for the media uploader: allowed types,
 * filename sanitization, and extension/content-type mapping. Kept separate so
 * they can be unit-tested without Express or Mongo.
 */

'use strict';

// Raster image types only. SVG is deliberately excluded — it can carry embedded
// scripts (stored-XSS risk when served from your own domain).
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — safely under Mongo's 16 MB doc limit

function isAllowedMime(mimetype) {
  return Object.prototype.hasOwnProperty.call(ALLOWED, String(mimetype || '').toLowerCase());
}

function extForMime(mimetype) {
  return ALLOWED[String(mimetype || '').toLowerCase()] || null;
}

// Sanitize a user-supplied filename into something safe for a URL path: strip
// directory parts, keep [a-z0-9-_], collapse the rest to '-', and force the
// extension to match the detected mimetype so the URL/content-type can't lie.
function sanitizeFilename(name, mimetype) {
  const ext = extForMime(mimetype) || 'bin';
  let base = String(name || 'image')
    .replace(/^.*[\\/]/, '')          // strip any path
    .replace(/\.[^.]*$/, '')          // strip existing extension
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')    // safe chars only
    .replace(/^-+|-+$/g, '')          // trim dashes
    .slice(0, 60);
  if (!base) base = 'image';
  return `${base}.${ext}`;
}

// Build the public URL for an upload.
function publicUrl(id, filename) {
  return `/wp-content/uploads/${id}/${filename}`;
}

module.exports = { ALLOWED, MAX_BYTES, isAllowedMime, extForMime, sanitizeFilename, publicUrl };
