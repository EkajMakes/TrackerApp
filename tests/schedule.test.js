import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  blocksForDay,
  formatClock,
  parseClock,
  scheduleForDay,
  scheduleView,
} from '../js/schedule.js';
import { at, cfg } from './helpers.js';

const schedule = JSON.parse(readFileSync(new URL('../schedule.json', import.meta.url), 'utf8'));

const MON = '2026-09-07'; // a Monday
const TUE = '2026-09-08';
const WED = '2026-09-09';

/* ------------------------------------------------------------------ *
 * 24+ notation                                                        *
 * ------------------------------------------------------------------ */

test('a 24:30 block parses as 12:30am and sorts after a 23:00 block', () => {
  assert.equal(parseClock('24:30'), 1470);
  assert.equal(parseClock('23:00'), 1380);
  assert.ok(parseClock('24:30') > parseClock('23:00'), 'past-midnight sorts last, not first');

  assert.equal(formatClock(1470), '12:30am');
  assert.equal(formatClock(1530), '1:30am');
  assert.equal(formatClock(0), '12:00am');
  assert.equal(formatClock(720), '12:00pm');
  assert.equal(formatClock(1380), '11:00pm');

  // And in a real day: Monday ends 23:30 → 24:30 → 25:30.
  const blocks = blocksForDay(schedule, MON, cfg);
  const tail = blocks.slice(-2);
  assert.deepEqual(tail.map((b) => b.label), ['Apply for jobs', 'Wind down']);
  assert.equal(tail[1].timeRange, '12:30am – 1:30am');
  assert.ok(tail[1].pastMidnight);
  assert.ok(tail[1].start > tail[0].start, 'and it really is later in absolute time');
});

test('a past-midnight block resolves to the following calendar morning', () => {
  const blocks = blocksForDay(schedule, MON, cfg);
  const windDown = blocks.at(-1);
  // 24:30 on Monday is 00:30 on Tuesday.
  assert.equal(windDown.start, at(TUE, 0, 30));
  assert.equal(windDown.end, at(TUE, 1, 30));
});

test('blocks always come back in chronological order', () => {
  for (const day of [MON, TUE, WED, '2026-09-12', '2026-09-13']) {
    const blocks = blocksForDay(schedule, day, cfg);
    for (let i = 1; i < blocks.length; i += 1) {
      assert.ok(blocks[i].start >= blocks[i - 1].start, `${day} is out of order at index ${i}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The app-day, not the weekday                                        *
 * ------------------------------------------------------------------ */

test('at 1am the schedule is still yesterday’s, because the app-day has not turned', () => {
  // 1am on Tuesday is inside Monday's app-day (the boundary is 02:00).
  const view = scheduleView(schedule, at(TUE, 1, 0), cfg);
  assert.equal(view.appDate, MON, 'the app-day, not the wall-clock date');
  assert.equal(view.weekday, 'mon', 'and therefore Monday’s blocks');
  assert.equal(view.isToday, true, 'it is still "today" as far as the app is concerned');

  // Monday's 24:30 block is the one actually running at 1am Tuesday.
  assert.equal(view.current?.label, 'Wind down');
  assert.equal(view.current?.remainingLabel, '30 min left');
});

test('at 2am the app-day turns over and the schedule follows', () => {
  const before = scheduleView(schedule, at(TUE, 1, 59), cfg);
  const after = scheduleView(schedule, at(TUE, 2, 1), cfg);
  assert.equal(before.appDate, MON);
  assert.equal(after.appDate, TUE, 'the 02:00 boundary moves the schedule, not midnight');
  assert.equal(after.weekday, 'tue');
});

test('browsing steps days without losing today', () => {
  const now = at(TUE, 12, 0);
  assert.equal(scheduleView(schedule, now, cfg, 0).appDate, TUE);
  assert.equal(scheduleView(schedule, now, cfg, -1).appDate, MON);
  assert.equal(scheduleView(schedule, now, cfg, 1).appDate, WED);
  assert.equal(scheduleView(schedule, now, cfg, 1).isToday, false);
  assert.equal(scheduleView(schedule, now, cfg, 1).today, TUE, 'today is still reported');
});

/* ------------------------------------------------------------------ *
 * Current block, boundaries and gaps                                  *
 * ------------------------------------------------------------------ */

test('the current block is identified at a boundary instant', () => {
  const blocks = blocksForDay(schedule, TUE, cfg);
  const gym = blocks.find((b) => b.label === 'Gym');

  // A block owns its start instant...
  const atStart = scheduleForDay(schedule, TUE, gym.start, cfg);
  assert.equal(atStart.current?.label, 'Gym');
  assert.equal(atStart.current.remainingMs, gym.end - gym.start);

  // ...and has handed over by its end instant, which the next block owns.
  const atEnd = scheduleForDay(schedule, TUE, gym.end, cfg);
  assert.notEqual(atEnd.current?.label, 'Gym', 'the end instant belongs to the next block');
  assert.equal(atEnd.current?.start, gym.end);

  // One millisecond before the end is still inside it.
  const justBefore = scheduleForDay(schedule, TUE, gym.end - 1, cfg);
  assert.equal(justBefore.current?.label, 'Gym');
});

test('a gap reports open time and names what is next', () => {
  // Tuesday has nothing between 22:45 (edit video ends) and 23:30.
  const blocks = blocksForDay(schedule, TUE, cfg);
  const edit = blocks.find((b) => b.label === 'Edit video');
  const inGap = scheduleForDay(schedule, TUE, edit.end + 5 * 60000, cfg);

  assert.equal(inGap.current, null, 'nothing is running');
  assert.ok(inGap.gap, 'so the gap is reported');
  assert.equal(inGap.gap.nextLabel, 'Apply for jobs');
  assert.equal(inGap.gap.untilLabel, '11:30pm');
  assert.equal(inGap.gap.remainingLabel, '40 min');
  assert.equal(inGap.next.label, 'Apply for jobs');
});

test('before the first block and after the last, the day is not "in progress"', () => {
  const blocks = blocksForDay(schedule, TUE, cfg);

  const early = scheduleForDay(schedule, TUE, blocks[0].start - 60000, cfg);
  assert.equal(early.current, null);
  assert.equal(early.notStarted, true);
  assert.equal(early.nowFraction, null, 'no now-line before the day begins');

  const late = scheduleForDay(schedule, TUE, blocks.at(-1).end + 60000, cfg);
  assert.equal(late.current, null);
  assert.equal(late.finished, true);
  assert.equal(late.gap, null, 'a finished day has no "next"');
  assert.equal(late.nowFraction, null);
});

test('the now-line sits proportionally through the day', () => {
  const blocks = blocksForDay(schedule, TUE, cfg);
  const start = blocks[0].start;
  const end = blocks.at(-1).end;
  const middle = scheduleForDay(schedule, TUE, start + (end - start) / 2, cfg);
  assert.ok(Math.abs(middle.nowFraction - 0.5) < 0.001);
});

test('every block carries its category colour and label', () => {
  for (const block of blocksForDay(schedule, WED, cfg)) {
    assert.ok(block.color, `${block.label} has no colour`);
    assert.ok(block.categoryLabel, `${block.label} has no category label`);
    assert.match(block.color, /^#[0-9a-f]{6}$/i);
    assert.ok(block.timeRange.includes('–'));
  }
});

test('states partition the day: past, current, future', () => {
  const blocks = blocksForDay(schedule, TUE, cfg);
  const lunch = blocks.find((b) => b.label === 'Lunch');
  const view = scheduleForDay(schedule, TUE, lunch.start + 60000, cfg);

  const states = view.blocks.map((b) => b.state);
  assert.equal(states.filter((s) => s === 'current').length, 1, 'exactly one current block');
  // Past blocks all precede the current one, futures all follow it.
  const currentIndex = states.indexOf('current');
  assert.ok(states.slice(0, currentIndex).every((s) => s === 'past'));
  assert.ok(states.slice(currentIndex + 1).every((s) => s === 'future'));
});

test('an unknown day renders as empty rather than throwing', () => {
  const view = scheduleForDay({ days: {}, categories: {} }, TUE, at(TUE, 12, 0), cfg);
  assert.equal(view.empty, true);
  assert.deepEqual(view.blocks, []);
  assert.equal(view.current, null);
  assert.equal(view.gap, null);
});

test('a malformed time is rejected loudly rather than silently mis-sorted', () => {
  assert.throws(() => parseClock('9:70'), /minutes out of range/);
  assert.throws(() => parseClock('noon'), /unparseable/);
});
