/**
 * time.js — PURE app-time math.
 *
 * No DOM, no IndexedDB, no Date.now(), no new Date() without an argument.
 * Every function takes the instant it should reason about as an argument.
 *
 * All wall-clock reasoning goes through Intl with the IANA zone from config.
 * No UTC offset is ever hardcoded or persisted; DST resolves itself on every
 * call (CLAUDE.md rule 7).
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DAY_MS = 86400000;
const formatterCache = new Map();

function formatterFor(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `instantMs` in `timeZone`. */
export function zonedParts(instantMs, timeZone) {
  const parts = {};
  for (const p of formatterFor(timeZone).formatToParts(instantMs)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // Intl renders midnight as hour 24 in some engines under h23; normalise.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

/** The zone's true UTC offset (ms) at a given instant. Derived, never stored. */
export function offsetAt(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - instantMs;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant.
 *
 * Two-pass fixpoint, then a verification pass:
 *  - normal times round-trip exactly;
 *  - a time that does not exist (spring forward) resolves FORWARD past the gap;
 *  - an ambiguous time (fall back) resolves to the FIRST occurrence.
 */
export function wallToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const o1 = offsetAt(naive, timeZone);
  const c1 = naive - o1;
  const o2 = offsetAt(c1, timeZone);
  const c2 = naive - o2;

  for (const candidate of c2 <= c1 ? [c2, c1] : [c1, c2]) {
    const p = zonedParts(candidate, timeZone);
    if (
      p.year === year && p.month === month && p.day === day &&
      p.hour === hour && p.minute === minute && p.second === second
    ) return candidate;
  }
  // Nonexistent local time: take the later candidate, i.e. just after the gap.
  return Math.max(c1, c2);
}

/* ------------------------------------------------------------------ *
 * Civil date helpers — plain YYYY-MM-DD strings, no timezone involved *
 * ------------------------------------------------------------------ */

export function parseDate(appDate) {
  const [year, month, day] = appDate.split('-').map(Number);
  return { year, month, day };
}

export function formatDate({ year, month, day }) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(year, 4)}-${p(month)}-${p(day)}`;
}

export function addDays(appDate, n) {
  const { year, month, day } = parseDate(appDate);
  const d = new Date(Date.UTC(year, month - 1, day) + n * DAY_MS);
  return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

export function daysBetween(fromDate, toDate) {
  const a = parseDate(fromDate);
  const b = parseDate(toDate);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
}

/** Weekday of an app-date label: 'sun' … 'sat'. */
export function weekdayOf(appDate) {
  const { year, month, day } = parseDate(appDate);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/* --------------------------------------- *
 * App-day and app-week boundaries          *
 * --------------------------------------- */

/**
 * The app-day an instant falls in. An app-day runs
 * [D boundaryHour, D+1 boundaryHour) in the configured zone, so anything
 * before the boundary hour belongs to the previous calendar date.
 */
export function appDateOf(instantMs, cfg) {
  const { hour, timezone } = cfg.dayBoundary;
  const p = zonedParts(instantMs, timezone);
  const label = formatDate({ year: p.year, month: p.month, day: p.day });
  return p.hour < hour ? addDays(label, -1) : label;
}

/** The instant an app-day opens (its boundaryHour, resolved through DST). */
export function dayBoundaryInstant(appDate, cfg) {
  const { hour, timezone } = cfg.dayBoundary;
  return wallToInstant({ ...parseDate(appDate), hour }, timezone);
}

/** The instant an app-day closes — identical to the next app-day's open. */
export function dayCloseInstant(appDate, cfg) {
  return dayBoundaryInstant(addDays(appDate, 1), cfg);
}

export function weekStartIndex(cfg) {
  const idx = WEEKDAYS.indexOf(String(cfg.weekStart ?? 'monday').slice(0, 3).toLowerCase());
  return idx === -1 ? 1 : idx;
}

/** The app-date of the week-start day that opens the week containing appDate. */
export function weekKeyOf(appDate, cfg) {
  const startIdx = weekStartIndex(cfg);
  const idx = WEEKDAYS.indexOf(weekdayOf(appDate));
  return addDays(appDate, -((idx - startIdx + 7) % 7));
}

export function weekKeyAfter(weekKey) {
  return addDays(weekKey, 7);
}

export function weekKeyBefore(weekKey) {
  return addDays(weekKey, -7);
}

/** True when this app-day's CLOSE is also the week boundary. */
export function isWeekBoundaryClose(appDate, cfg) {
  return WEEKDAYS.indexOf(weekdayOf(addDays(appDate, 1))) === weekStartIndex(cfg);
}

/**
 * Every day boundary in (fromMs, toMs], oldest first, as
 * { closingAppDate, instant } — the app-day that closed and when it closed.
 *
 * Enumerates app-days, not fixed 24h spans, so a DST day is neither skipped
 * nor processed twice.
 */
export function boundariesBetween(fromMs, toMs, cfg) {
  const out = [];
  if (!(toMs > fromMs)) return out;
  let closingAppDate = appDateOf(fromMs, cfg);
  let instant = dayCloseInstant(closingAppDate, cfg);
  while (instant <= toMs) {
    out.push({ closingAppDate, instant });
    closingAppDate = addDays(closingAppDate, 1);
    instant = dayCloseInstant(closingAppDate, cfg);
  }
  return out;
}
