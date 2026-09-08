import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  appDateOf,
  boundariesBetween,
  dayBoundaryInstant,
  dayCloseInstant,
  isWeekBoundaryClose,
  offsetAt,
  wallToInstant,
  weekKeyAfter,
  weekKeyOf,
  weekdayOf,
} from '../js/time.js';
import { cfg, at } from './helpers.js';

const TZ = 'America/Chicago';
const HOUR = 3600000;
const localOf = (ms) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, dateStyle: 'short', timeStyle: 'long' })
    .format(ms);

test('app-day labels follow the 02:00 boundary, not midnight', () => {
  // 01:30 Tuesday still belongs to app-day Monday.
  assert.equal(appDateOf(at('2026-09-08', 1, 30), cfg), '2026-09-07');
  assert.equal(appDateOf(at('2026-09-08', 2, 0), cfg), '2026-09-08');
  assert.equal(appDateOf(at('2026-09-08', 23, 59), cfg), '2026-09-08');
  // The roster is taken from the label, so the 01:30 tap is a Monday tap.
  assert.equal(weekdayOf(appDateOf(at('2026-09-08', 1, 30), cfg)), 'mon');
});

test('week keys anchor on Monday and advance by seven days', () => {
  assert.equal(weekKeyOf('2026-09-07', cfg), '2026-09-07'); // Monday itself
  assert.equal(weekKeyOf('2026-09-13', cfg), '2026-09-07'); // the Sunday it closes with
  assert.equal(weekKeyOf('2026-09-14', cfg), '2026-09-14');
  assert.equal(weekKeyAfter('2026-09-07'), '2026-09-14');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('only a Sunday close is also the week boundary', () => {
  assert.equal(isWeekBoundaryClose('2026-09-13', cfg), true); // Sunday → Monday 02:00
  assert.equal(isWeekBoundaryClose('2026-09-12', cfg), false);
  assert.equal(isWeekBoundaryClose('2026-09-07', cfg), false);
});

test('boundaries are enumerated oldest-first, one per app-day', () => {
  const from = at('2026-09-07', 8);
  const to = at('2026-09-10', 8);
  const b = boundariesBetween(from, to, cfg);
  assert.deepEqual(b.map((x) => x.closingAppDate), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.ok(b.every((x, i) => i === 0 || x.instant > b[i - 1].instant));
});

test('boundariesBetween is exclusive of the start and inclusive of the end', () => {
  const close = dayCloseInstant('2026-09-07', cfg);
  assert.equal(boundariesBetween(close - 1, close, cfg).length, 1);
  assert.equal(boundariesBetween(close, close, cfg).length, 0);
  assert.equal(boundariesBetween(close, close + 1, cfg).length, 0);
});

test('the UTC offset is derived per instant, never hardcoded', () => {
  assert.equal(offsetAt(Date.UTC(2026, 0, 15), TZ) / HOUR, -6); // CST
  assert.equal(offsetAt(Date.UTC(2026, 6, 15), TZ) / HOUR, -5); // CDT
});

test('DST spring forward: the nonexistent 02:00 resolves forward past the gap', () => {
  // 2026-03-08 02:00 America/Chicago does not exist; the boundary lands at 03:00 CDT.
  const open = dayBoundaryInstant('2026-03-08', cfg);
  assert.match(localOf(open), /3:00:00 AM CDT|3:00:00 AM CDT/);

  // No app-day is skipped or processed twice across the transition.
  const b = boundariesBetween(at('2026-03-06', 8), at('2026-03-10', 8), cfg);
  assert.deepEqual(b.map((x) => x.closingAppDate), ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09']);

  // The app-day that follows the shifted boundary is the short one.
  assert.equal((dayCloseInstant('2026-03-08', cfg) - open) / HOUR, 23);
});

test('DST fall back: the long day is 25 hours and 01:30 takes the first occurrence', () => {
  const open = dayBoundaryInstant('2026-10-31', cfg);
  assert.equal((dayCloseInstant('2026-10-31', cfg) - open) / HOUR, 25);

  // 01:30 on 2026-11-01 happens twice; we take the earlier (CDT) one.
  const ambiguous = wallToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, TZ);
  assert.equal(offsetAt(ambiguous, TZ) / HOUR, -5);

  const b = boundariesBetween(at('2026-10-29', 8), at('2026-11-03', 8), cfg);
  assert.deepEqual(
    b.map((x) => x.closingAppDate),
    ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
  );
  assert.equal(new Set(b.map((x) => x.closingAppDate)).size, b.length); // no duplicates
});

test('elapsed time is conserved across both transitions', () => {
  const spring = dayCloseInstant('2026-03-09', cfg) - dayBoundaryInstant('2026-03-06', cfg);
  const fall = dayCloseInstant('2026-11-02', cfg) - dayBoundaryInstant('2026-10-29', cfg);
  assert.equal(spring / HOUR, 4 * 24 - 1); // one hour lost, exactly once
  assert.equal(fall / HOUR, 5 * 24 + 1); // one hour gained, exactly once
});
