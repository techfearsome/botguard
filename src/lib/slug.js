/**
 * Slug generation utilities.
 *
 * If the user provides a slug, we use it as-is (after light sanitization).
 * If the user only provides a name, we derive a slug from it.
 * If the resulting slug collides with an existing one, we append random digits.
 */

/**
 * Sanitize a string into a URL-safe slug:
 *   - lowercase
 *   - replace whitespace and underscores with hyphens
 *   - drop everything except a-z, 0-9, and hyphens
 *   - collapse multiple hyphens
 *   - trim leading/trailing hyphens
 *   - cap length at 60 chars
 */
function slugify(input) {
  if (!input) return '';
  return String(input)
    .toLowerCase()
    .normalize('NFKD')                 // decompose accented characters (é → e + ́)
    .replace(/[\u0300-\u036f]/g, '')   // strip combining marks
    .replace(/[\s_]+/g, '-')           // whitespace and underscores → hyphen
    .replace(/[^a-z0-9-]/g, '')        // drop everything else
    .replace(/-+/g, '-')               // collapse repeated hyphens
    .replace(/^-+|-+$/g, '')           // trim hyphens
    .slice(0, 60);
}

/**
 * Resolve a slug for a new entity.
 *
 * @param {string} providedSlug - user-supplied slug (may be empty)
 * @param {string} name - user-supplied name (used as fallback)
 * @param {Function} existsFn - async function (slug) => boolean indicating collision
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=10] - how many random suffixes to try before giving up
 * @returns {Promise<string>} a unique, URL-safe slug
 *
 * Behavior:
 *   - If providedSlug is non-empty: sanitize it, then check uniqueness.
 *     If it collides, add a random 4-digit suffix and retry until unique.
 *   - If providedSlug is empty: derive from name, then same uniqueness loop.
 *   - If we somehow can't find a unique slug after maxAttempts, throw.
 */
async function resolveSlug(providedSlug, name, existsFn, opts = {}) {
  const maxAttempts = opts.maxAttempts || 10;

  let base = slugify(providedSlug) || slugify(name);
  if (!base) {
    // Neither slug nor name produced anything sluggable - fall back to a random ID
    base = 'item-' + randomDigits(6);
  }

  // First try: bare slug
  if (!(await existsFn(base))) return base;

  // Collision: append random digits until unique
  for (let i = 0; i < maxAttempts; i++) {
    // Increase digit count slightly each round to expand the namespace if we keep colliding
    const digitCount = 4 + Math.floor(i / 3);
    const candidate = `${base}-${randomDigits(digitCount)}`.slice(0, 60);
    if (!(await existsFn(candidate))) return candidate;
  }

  throw new Error(`Could not generate unique slug after ${maxAttempts} attempts (base: ${base})`);
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

module.exports = { slugify, resolveSlug, randomDigits };
