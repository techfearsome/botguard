/**
 * Date-range parser for admin list pages.
 *
 * All admin list pages (Click Log, Conversions, Replay, Dashboard) default to
 * showing "today" only - the data that's actionable right now. The user can
 * widen the range via a `?range=` query parameter.
 *
 * Supported ranges:
 *   - today      (default)   midnight server-local up to now
 *   - yesterday              previous calendar day
 *   - 7d                     last 7 days
 *   - 30d                    last 30 days
 *   - all                    no time filter
 *   - custom                 use date_from / date_to query params (YYYY-MM-DD)
 *
 * Usage:
 *   const range = parseRange(req.query);
 *   if (range.gte || range.lte) filter.ts = {};
 *   if (range.gte) filter.ts.$gte = range.gte;
 *   if (range.lte) filter.ts.$lte = range.lte;
 *
 * Why this lives in a helper:
 *   - The same default ("today") applies in 4+ routes; one bug fix should
 *     touch one file.
 *   - The label/option list is shared between EJS templates - we expose it
 *     via RANGE_OPTIONS so views render a consistent dropdown.
 */

const VALID_RANGES = new Set(['today', 'yesterday', '7d', '30d', 'all', 'custom']);
const DEFAULT_RANGE = 'today';

const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfYesterday() {
  const d = startOfToday();
  d.setDate(d.getDate() - 1);
  return d;
}

function endOfYesterday() {
  const d = startOfToday();
  d.setMilliseconds(-1);    // 23:59:59.999 of yesterday
  return d;
}

function parseDate(s) {
  if (!s || typeof s !== 'string') return null;
  // Accept YYYY-MM-DD; treat as start-of-day in server-local time
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return isNaN(d) ? null : d;
}

/**
 * @param {object} query - typically req.query
 * @returns {{ range: string, gte: Date|null, lte: Date|null, label: string }}
 */
function parseRange(query) {
  let range = String(query?.range || '').toLowerCase();
  if (!VALID_RANGES.has(range)) range = DEFAULT_RANGE;

  let gte = null, lte = null, label = '';

  if (range === 'today') {
    gte = startOfToday();
    label = 'Today';
  } else if (range === 'yesterday') {
    gte = startOfYesterday();
    lte = endOfYesterday();
    label = 'Yesterday';
  } else if (range === '7d') {
    gte = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    label = 'Last 7 days';
  } else if (range === '30d') {
    gte = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    label = 'Last 30 days';
  } else if (range === 'all') {
    label = 'All time';
  } else if (range === 'custom') {
    gte = parseDate(query?.date_from);
    const toDate = parseDate(query?.date_to);
    if (toDate) {
      // Treat date_to as inclusive end-of-day
      lte = new Date(toDate);
      lte.setHours(23, 59, 59, 999);
    }
    label = 'Custom range';
  }

  return { range, gte, lte, label };
}

/**
 * Apply parsed range to a Mongo filter object's `ts` field.
 * Mutates and returns the filter for chainability.
 */
function applyRangeToFilter(filter, parsed) {
  if (!parsed.gte && !parsed.lte) return filter;
  filter.ts = filter.ts || {};
  if (parsed.gte) filter.ts.$gte = parsed.gte;
  if (parsed.lte) filter.ts.$lte = parsed.lte;
  return filter;
}

module.exports = {
  parseRange,
  applyRangeToFilter,
  RANGE_OPTIONS,
  DEFAULT_RANGE,
  VALID_RANGES,
};
