/**
 * campaignSchedule.js — checks whether a campaign is within its scheduled
 * run windows. Pure function, no side effects, fully testable.
 *
 * Schedule format (stored on Campaign.ad_schedule):
 *   {
 *     enabled: false,         // default OFF — campaign runs 24/7
 *     timezone: 'America/New_York',  // IANA timezone for the schedule times
 *     rules: [
 *       { day: 1, start: '20:30', end: '00:00' },  // Mon 20:30 → Tue 00:00
 *       { day: 2, start: '00:00', end: '02:00' },  // Tue 00:00 → 02:00
 *       ...
 *     ]
 *   }
 *
 * Days: 0 = Sunday, 1 = Monday … 6 = Saturday (matches JS Date.getDay()).
 * Times are HH:MM in the specified timezone.
 *
 * A rule where end <= start means it wraps past midnight (e.g. 20:30 → 02:00
 * is treated as 20:30 → 23:59 on that day + 00:00 → 02:00 on the next).
 * However, Google Ads models this as TWO separate rules (one for each side),
 * so the UI + storage follows that pattern. Cross-midnight wrapping is handled
 * here as a safety net in case rules are entered that way.
 *
 * Resolution: if the current time in the schedule's timezone falls within ANY
 * rule, the campaign is "in schedule" (should run). Otherwise it's "out of
 * schedule" (should behave as paused). An empty rules array with enabled=true
 * means the campaign is always out of schedule (always paused by schedule).
 */

'use strict';

/**
 * Convert a Date to the day-of-week and minutes-since-midnight in a given
 * IANA timezone. Falls back to UTC if the timezone is invalid.
 */
function dateInTimezone(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = {};
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;

    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = dayMap[parts.weekday] ?? date.getUTCDay();
    const hour = parseInt(parts.hour, 10) || 0;
    const minute = parseInt(parts.minute, 10) || 0;
    return { day, minutes: hour * 60 + minute };
  } catch (_) {
    // Invalid timezone — fall back to UTC.
    return { day: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

/**
 * Parse "HH:MM" to minutes since midnight.
 */
function parseTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Check whether the current moment falls within any of the campaign's
 * scheduled run windows.
 *
 * @param {object} schedule - Campaign.ad_schedule
 * @param {Date}   [now]    - override for testing (defaults to new Date())
 * @returns {{ inSchedule: boolean, reason: string }}
 *   inSchedule=true  → campaign should run normally
 *   inSchedule=false → campaign is outside its schedule (treat as paused)
 */
function isInSchedule(schedule, now) {
  if (!schedule || !schedule.enabled) {
    return { inSchedule: true, reason: 'schedule_disabled' };
  }
  if (!Array.isArray(schedule.rules) || schedule.rules.length === 0) {
    return { inSchedule: false, reason: 'no_rules' };
  }

  const d = now || new Date();
  const tz = schedule.timezone || 'UTC';
  const { day, minutes } = dateInTimezone(d, tz);

  for (const rule of schedule.rules) {
    if (rule.day !== day) continue;
    const start = parseTime(rule.start);
    const end = parseTime(rule.end);

    if (end > start) {
      // Normal window: e.g. 08:00 → 17:00
      if (minutes >= start && minutes < end) {
        return { inSchedule: true, reason: 'in_window' };
      }
    } else if (end <= start && end > 0) {
      // Wraps past midnight: e.g. 20:30 → 02:00
      // On this day, 20:30 → 23:59 is valid.
      if (minutes >= start) {
        return { inSchedule: true, reason: 'in_window_pre_midnight' };
      }
    } else if (end === 0 && start > 0) {
      // Ends at midnight: e.g. 20:30 → 00:00 means 20:30 → 23:59:59
      if (minutes >= start) {
        return { inSchedule: true, reason: 'in_window_to_midnight' };
      }
    }
  }

  return { inSchedule: false, reason: 'outside_schedule' };
}

module.exports = { isInSchedule, dateInTimezone, parseTime };
