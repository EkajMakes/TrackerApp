import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, validateConfig } from '../js/config.js';
import {
  award,
  createWorld,
  completeTask,
  groupedFailures,
  openFailures,
  pendingSummary,
  rollover,
  settleDayClose,
  spendSkip,
  tierFor,
} from '../js/scoring.js';
import { at, cfg, done, freshWorld, makeConfig, onlyTasks, rawConfig, snapshot } from './helpers.js';

const WEEK1 = '2026-09-07'; // a Monday
const WEEK2 = '2026-09-14';
const WEEK3 = '2026-09-21';
const mondayMorning = (weekKey, config = cfg) => at(weekKey, 2, 5, config);

const failuresFor = (world, taskId) =>
  world.failures.filter((f) => f.taskId === taskId);

/* ------------------------------------------------------------------ *
 * Config validation                                                   *
 * ------------------------------------------------------------------ */

test('config: the shipped config.json is valid and defaults dailyTarget to 1', () => {
  assert.equal(cfg.tasks.pray.dailyTarget, 1);
  assert.equal(cfg.tasks.gym.anchor, true);
  assert.equal(cfg.tasks.pray.anchor, false);
});

test('config: penalty !== points on a quota or daily task refuses to boot', () => {
  assert.throws(
    () => makeConfig((raw) => { raw.tasks.gym.penalty = 10; }),
    (err) => err instanceof ConfigError && /penalty must equal points/.test(err.message),
  );
  assert.throws(
    () => makeConfig((raw) => { raw.tasks.jobs.penalty = 1; }),
    ConfigError,
  );
  // A bonus task has no penalty and is unaffected.
  assert.doesNotThrow(() => validateConfig(structuredClone(rawConfig)));
});

/* ------------------------------------------------------------------ *
 * Quota shortfalls and the Monday-morning regression                  *
 * ------------------------------------------------------------------ */

test('quota shortfall at week close is tagged redeemThroughWeekKey = W+1', () => {
  let w = freshWorld(WEEK1);
  w = done(w, 'gym', '2026-09-07', { hour: 10 });
  w = done(w, 'gym', '2026-09-09', { hour: 10 });
  w = done(w, 'gym', '2026-09-11', { hour: 10 });
  w = rollover(w, mondayMorning(WEEK2), cfg);

  const gym = failuresFor(w, 'gym');
  assert.equal(gym.length, 2, 'target 5 minus 3 completions = 2 entries');
  for (const f of gym) {
    assert.equal(f.kind, 'quota');
    assert.equal(f.incurredWeekKey, WEEK1);
    assert.equal(f.redeemThroughWeekKey, WEEK2, 'lives through the whole following week');
    assert.equal(f.resolvedAt, null);
    assert.equal(f.penalty, 15);
  }
  // Keyed on the week, not on the Sunday that happened to close it.
  assert.deepEqual(gym.map((f) => f.id), ['fail:gym:2026-09-07:0', 'fail:gym:2026-09-07:1']);
});

test('Monday-morning regression: the failure log is non-empty, open and redeemable', () => {
  let w = freshWorld(WEEK1);
  w.state.balance = 500; // a real user with points banked, so the floor is not in play
  w = done(w, 'gym', '2026-09-08', { hour: 10 });
  w = rollover(w, mondayMorning(WEEK2), cfg);

  const open = openFailures(w);
  assert.ok(open.length > 0, 'a week with a shortfall must leave redeemable entries');
  const gym = open.filter((f) => f.taskId === 'gym');
  assert.equal(gym.length, 4);

  const balanceBefore = w.state.balance;
  const skipsBefore = w.skips.filter((s) => s.spentAt === null && s.lapsedAt === null).length;
  const res = spendSkip(w, gym[0].id, mondayMorning(WEEK2) + 60000);

  assert.equal(res.ok, true, 'the entry must be redeemable on Monday morning');
  assert.equal(res.refunded, 15);
  assert.equal(res.world.state.balance, balanceBefore + 15);
  assert.equal(
    res.world.skips.filter((s) => s.spentAt === null && s.lapsedAt === null).length,
    skipsBefore - 1,
  );
  const cleared = res.world.failures.find((f) => f.id === gym[0].id);
  assert.equal(cleared.resolvedVia, 'skip');
  assert.ok(res.world.failures.some((f) => f.id === gym[0].id), 'resolved, never deleted');
});

test('a Sunday daily miss survives its own week boundary', () => {
  const c = onlyTasks(['jobs']);
  let w = freshWorld(WEEK1, c);
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
    w = done(w, 'jobs', d, { hour: 10, config: c });
  }
  // Sunday 2026-09-13 is missed; its close IS the week boundary.
  w = rollover(w, mondayMorning(WEEK2, c), c);

  const sunday = w.failures.filter((f) => f.incurredAppDate === '2026-09-13');
  assert.equal(sunday.length, 1);
  assert.equal(sunday[0].id, 'fail:jobs:2026-09-13:0');
  assert.equal(sunday[0].resolvedAt, null, 'must not be swallowed by the same-instant week close');
  assert.equal(sunday[0].redeemThroughWeekKey, WEEK2);
});

test('daily misses are written per dailyTarget shortfall', () => {
  const c = onlyTasks(['pray'], (raw) => { raw.tasks.pray.dailyTarget = 3; });
  let w = freshWorld(WEEK1, c);
  w = done(w, 'pray', WEEK1, { hour: 9, config: c });
  w = done(w, 'pray', WEEK1, { hour: 12, config: c });
  const earned = w.state.balance;
  assert.equal(earned, 20, 'points are awarded per completion up to dailyTarget');

  w = rollover(w, at('2026-09-08', 3, 0, c), c);
  const day1 = w.failures.filter((f) => f.incurredAppDate === WEEK1);
  assert.equal(day1.length, 1, '3 required minus 2 done = 1 entry');
  assert.equal(w.state.balance, earned - 10);

  // A fourth completion beyond dailyTarget records but pays nothing.
  const extra = completeTask(w, { taskId: 'pray', timestamp: at('2026-09-08', 9, 0, c) }, c);
  const again = completeTask(
    extra.world, { taskId: 'pray', timestamp: at('2026-09-08', 10, 0, c) }, c,
  );
  const third = completeTask(
    again.world, { taskId: 'pray', timestamp: at('2026-09-08', 11, 0, c) }, c,
  );
  const fourth = completeTask(
    third.world, { taskId: 'pray', timestamp: at('2026-09-08', 12, 0, c) }, c,
  );
  assert.equal(fourth.completion.pointsAwarded, 0);
  assert.equal(fourth.completion.gateReason, 'over-target');
});

/* ------------------------------------------------------------------ *
 * Skips: refunds and the guard                                        *
 * ------------------------------------------------------------------ */

test('a skip refunds actualDeduction, not the configured penalty', () => {
  const c = onlyTasks(['pray']);
  let w = freshWorld(WEEK1, c);
  // One 10-point miss above the floor, whatever the floor is retuned to.
  w.state.balance = c.balanceFloor + 10;
  w = rollover(w, at('2026-09-09', 3, 0, c), c); // two days missed

  const [first, second] = w.failures;
  assert.equal(first.penalty, 10);
  assert.equal(first.actualDeduction, 10, 'the first miss really cost 10');
  assert.equal(second.penalty, 10);
  assert.equal(second.actualDeduction, 0, 'the floor absorbed the second one entirely');
  assert.equal(w.state.balance, c.balanceFloor);

  const clamped = spendSkip(w, second.id, at('2026-09-09', 9, 0, c));
  assert.equal(clamped.ok, true);
  assert.equal(clamped.refunded, 0, 'refunding the config penalty here would mint free points');
  assert.equal(clamped.world.state.balance, c.balanceFloor);

  const real = spendSkip(clamped.world, first.id, at('2026-09-09', 10, 0, c));
  assert.equal(real.refunded, 10);
  assert.equal(real.world.state.balance, c.balanceFloor + 10);
});

test('the skip guard rejects a resolved or expired failure as a complete no-op', () => {
  const c = onlyTasks(['pray']);
  let w = freshWorld(WEEK1, c);
  w = rollover(w, at('2026-09-08', 3, 0, c), c);
  const target = w.failures[0];

  // (a) spending twice: the second attempt changes nothing.
  const first = spendSkip(w, target.id, at('2026-09-08', 9, 0, c));
  assert.equal(first.ok, true);
  const before = snapshot(first.world);
  const second = spendSkip(first.world, target.id, at('2026-09-08', 10, 0, c));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-resolved');
  assert.equal(second.world, first.world, 'the same world object is returned');
  assert.equal(snapshot(second.world), before);

  // (b) an expired entry is permanently unredeemable.
  let aged = rollover(w, mondayMorning(WEEK3, c), c); // two week boundaries later
  const expired = aged.failures.find((f) => f.id === target.id);
  assert.equal(expired.resolvedVia, 'expired');
  const agedBefore = snapshot(aged);
  const attempt = spendSkip(aged, target.id, mondayMorning(WEEK3, c) + 60000);
  assert.equal(attempt.ok, false);
  assert.equal(attempt.reason, 'expired');
  assert.equal(attempt.world, aged);
  assert.equal(snapshot(attempt.world), agedBefore, 'no balance move, no skip consumed');
});

test('purchased skips never lapse, weekly grants do', () => {
  let w = freshWorld(WEEK1);
  w.state.balance = 400;
  const bought = { ...w, skips: [...w.skips, {
    id: 'skip:buy:test', source: 'purchase', grantedWeekKey: WEEK1,
    grantedAt: at(WEEK1, 9), redemptionId: 'rdm:test',
    spentAt: null, spentOnFailureId: null, lapsedAt: null,
  }] };
  const after = rollover(bought, mondayMorning(WEEK2), cfg);

  const purchase = after.skips.find((s) => s.id === 'skip:buy:test');
  assert.equal(purchase.lapsedAt, null, 'a skip bought for 250 points must not evaporate');
  const grants = after.skips.filter((s) => s.source === 'weekly-grant' && s.grantedWeekKey === WEEK1);
  assert.equal(grants.length, cfg.skipsPerWeek);
  assert.ok(grants.every((s) => s.lapsedAt !== null), 'unused weekly grants lapse');
  assert.ok(after.skips.every((s) => s.id !== undefined), 'lapsed rows are retained, never deleted');
  assert.equal(after.skips.filter((s) => s.grantedWeekKey === WEEK2).length, cfg.skipsPerWeek);
});

/* ------------------------------------------------------------------ *
 * Bonus settlement and the pending figure                             *
 * ------------------------------------------------------------------ */

test('bonus settles at day close under both gates', () => {
  const c = onlyTasks(['read', 'jobs']);

  // (a) no anchor all day → 0 points, recorded with the reason.
  let locked = freshWorld(WEEK1, c);
  locked = done(locked, 'read', WEEK1, { hour: 9, config: c });
  assert.equal(locked.state.balance, 0, 'a bonus tap banks nothing at tap time');
  locked = rollover(locked, at('2026-09-08', 3, 0, c), c);
  const gated = locked.completions.find((x) => x.taskId === 'read');
  assert.equal(gated.pointsAwarded, 0);
  assert.equal(gated.gateReason, 'anchor-missing');

  // (b) bonus first, anchor later the same day → it pays in full.
  let unlocked = freshWorld(WEEK1, c);
  unlocked = done(unlocked, 'read', WEEK1, { hour: 9, config: c });
  unlocked = done(unlocked, 'jobs', WEEK1, { hour: 20, config: c });
  unlocked = rollover(unlocked, at('2026-09-08', 3, 0, c), c);
  const paid = unlocked.completions.find((x) => x.taskId === 'read');
  assert.equal(paid.pointsAwarded, 8, 'the later anchor unlocks the earlier chore');
  assert.equal(paid.gateReason, null);
  assert.equal(paid.settledAt, at('2026-09-08', 2, 0, c), 'scored once, at the day close');
  assert.ok(paid.settledAt > paid.timestamp, 'not scored at tap time');

  // (c) the weekly cap absorbs what is over headroom.
  const capped = onlyTasks(['read', 'jobs'], (raw) => { raw.bonusWeeklyCap = 10; });
  let w = freshWorld(WEEK1, capped);
  w = done(w, 'read', WEEK1, { hour: 9, config: capped });
  w = done(w, 'jobs', WEEK1, { hour: 10, config: capped });
  w = rollover(w, at('2026-09-08', 3, 0, capped), capped);
  w = done(w, 'read', '2026-09-08', { hour: 9, config: capped });
  w = done(w, 'jobs', '2026-09-08', { hour: 10, config: capped });
  w = rollover(w, at('2026-09-09', 3, 0, capped), capped);

  const reads = w.completions.filter((x) => x.taskId === 'read');
  assert.equal(reads[0].pointsAwarded, 8);
  assert.equal(reads[1].pointsAwarded, 2, 'only the remaining headroom is paid');
  assert.equal(reads[1].gateReason, 'weekly-cap');
});

test('pending is gate-aware', () => {
  const c = onlyTasks(['read', 'jobs']);
  let w = freshWorld(WEEK1, c);
  const now = at(WEEK1, 10, 0, c);

  w = done(w, 'read', WEEK1, { hour: 9, config: c });
  let view = pendingSummary(w, now, c);
  assert.equal(view.pending, 8);
  assert.equal(view.locked, true, 'no anchor yet: the figure must not read as ordinary pending');
  assert.equal(view.anchoredToday, false);

  w = done(w, 'jobs', WEEK1, { hour: 10, config: c });
  view = pendingSummary(w, at(WEEK1, 11, 0, c), c);
  assert.equal(view.pending, 8);
  assert.equal(view.locked, false, 'the first anchor unlocks it in the same day');
  assert.equal(view.headroom, c.bonusWeeklyCap);

  // Pending is never folded into the balance.
  assert.equal(w.state.balance, 15, 'only the anchor task has banked points');
});

/* ------------------------------------------------------------------ *
 * Failure log grouping                                                *
 * ------------------------------------------------------------------ */

test('failures group on (taskId, penalty, actualDeduction) and sort by refund value', () => {
  const c = onlyTasks(['pray']);
  let w = freshWorld(WEEK1, c);
  w.state.balance = c.balanceFloor + 10; // the floor will clamp the second miss to 0
  w = rollover(w, at('2026-09-10', 3, 0, c), c); // three days missed

  const groups = groupedFailures(w);
  assert.equal(groups.length, 2, 'a clamped entry is not interchangeable with a full-price one');
  assert.deepEqual(
    groups.map((g) => [g.taskId, g.penalty, g.actualDeduction, g.count]),
    [['pray', 10, 10, 1], ['pray', 10, 0, 2]],
  );
  assert.equal(groups[0].actualDeduction, 10, 'sorted by what a skip actually returns');
  assert.equal(groups[1].totalPenalty, 20, 'the display penalty is still shown');
  assert.equal(groups[1].totalActual, 0);

  // Every id in a group refunds the same amount, so any one is interchangeable.
  for (const g of groups) {
    for (const id of g.ids) {
      assert.equal(w.failures.find((f) => f.id === id).actualDeduction, g.actualDeduction);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Multiplier                                                          *
 * ------------------------------------------------------------------ */

test('the multiplier uses the day-start tier and is never applied retroactively', () => {
  const c = onlyTasks(['jobs']);
  let w = freshWorld(WEEK1, c);
  const days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

  for (const d of days) {
    w = done(w, 'jobs', d, { hour: 10, config: c });
    w = rollover(w, at(d, 23, 59, c), c); // still the same app-day
    w = rollover(w, at(d, 2, 0, c) + 24 * 3600000 + 3600000, c); // past the close
  }

  const paid = w.completions.filter((x) => x.taskId === 'jobs').map((x) => x.pointsAwarded);
  // Streak at each day's start: 0,1,2,3,4 → tier 1.0 until the 4th day, then 1.05.
  assert.deepEqual(paid, [15, 15, 15, 16, 16]);
  assert.equal(w.state.currentStreak, 5);
  assert.equal(tierFor(w.state.currentStreak, c).name, 'Cooking');

  // Reaching a tier does not repay yesterday: earlier awards keep their value.
  assert.equal(w.completions[0].multiplierApplied, 1);
  assert.equal(w.completions[3].multiplierApplied, 1.05);
  assert.equal(award(15, tierFor(10, c)), 18);
});

test('a day with no anchor completion resets the streak', () => {
  const c = onlyTasks(['jobs', 'pray']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'jobs', WEEK1, { hour: 10, config: c });
  w = rollover(w, at('2026-09-08', 3, 0, c), c);
  assert.equal(w.state.currentStreak, 1);

  // pray is not an anchor: a day whose only completion is praying breaks it.
  w = done(w, 'pray', '2026-09-08', { hour: 10, config: c });
  w = rollover(w, at('2026-09-09', 3, 0, c), c);
  assert.equal(w.state.currentStreak, 0);
});

/* ------------------------------------------------------------------ *
 * Rollover: idempotency, catch-up, clocks                             *
 * ------------------------------------------------------------------ */

test('idempotency: settling the same state twice is byte-identical', () => {
  let base = freshWorld(WEEK1);
  base = done(base, 'gym', WEEK1, { hour: 10 });
  base = done(base, 'jobs', WEEK1, { hour: 11 });
  base = done(base, 'read', WEEK1, { hour: 12 });
  const now = mondayMorning(WEEK2);

  const once = rollover(base, now, cfg);
  const twice = rollover(once, now, cfg);
  assert.equal(snapshot(twice), snapshot(once), 'a repeated run must change nothing');

  // Two independent runs from the same input agree exactly.
  const parallel = rollover(base, now, cfg);
  assert.equal(snapshot(parallel), snapshot(once), 'settlement is deterministic');

  // Even replaying from a rewound pointer re-settles nothing: the day guard
  // and the deterministic ids make the second pass a no-op.
  const rewound = { ...once, state: { ...once.state, lastProcessedTimestamp: base.state.lastProcessedTimestamp } };
  const replayed = rollover(rewound, now, cfg);
  assert.equal(snapshot(replayed), snapshot(once), 'no duplicate rows, no double deduction');

  // The pass that settled the bonus started with it PENDING; assert it was
  // banked exactly once rather than trusting byte-equality of a later replay.
  const read = once.completions.filter((c) => c.taskId === 'read');
  assert.equal(read.length, 1);
  assert.equal(read[0].pointsAwarded, 8);
  assert.equal(
    once.completions.reduce((sum, c) => sum + (c.pointsAwarded ?? 0), 0),
    15 + 15 + 8,
    'gym + jobs at tap, read once at day close',
  );
});

test('re-settling a day whose bonus is already banked does not award it twice', () => {
  // The day guard is the first line of defence; this test removes it to prove
  // the second one — settlement only touches completions still pending.
  const c = onlyTasks(['read', 'jobs']);
  let base = freshWorld(WEEK1, c);
  base = done(base, 'read', WEEK1, { hour: 9, config: c });
  base = done(base, 'jobs', WEEK1, { hour: 10, config: c });

  const close = at('2026-09-08', 2, 0, c);
  const pending = base.completions.find((x) => x.taskId === 'read');
  assert.equal(pending.pointsAwarded, null, 'the pass below starts with an unsettled bonus');

  const settled = settleDayClose(base, WEEK1, close, c);
  assert.equal(settled.completions.find((x) => x.taskId === 'read').pointsAwarded, 8);

  const bypassed = {
    ...settled,
    state: { ...settled.state, lastSettledAppDate: '2026-09-06' },
  };
  const again = settleDayClose(bypassed, WEEK1, close, c);

  assert.equal(again.state.balance, settled.state.balance, 'no second award, no second deduction');
  assert.deepEqual(again.completions, settled.completions, 'the banked bonus is untouched');
  assert.equal(again.failures.length, settled.failures.length, 'deterministic ids block duplicates');
  assert.equal(again.skips.length, settled.skips.length);
  // The streak is the one thing the day guard alone protects, which is why the
  // guard exists in addition to the pending filter.
  assert.equal(again.state.currentStreak, settled.state.currentStreak + 1);
});

test('multi-week catch-up settles each week independently', () => {
  const w = rollover(freshWorld(WEEK1), at('2026-09-30', 9), cfg);

  // Three Sundays elapsed, so three week closes, each settled on its own counts.
  assert.equal(w.state.currentWeekKey, '2026-09-28');
  const gym = w.failures.filter((f) => f.taskId === 'gym');
  assert.equal(gym.length, 15, '5 short per week x 3 weeks, not one merged blob');
  assert.deepEqual(
    [...new Set(gym.map((f) => f.incurredWeekKey))].sort(),
    [WEEK1, WEEK2, WEEK3],
  );

  // Only the most recent cycle is still redeemable; older entries are resolved,
  // never removed.
  const open = openFailures(w);
  assert.ok(open.length > 0);
  assert.ok(
    open.every((f) => f.redeemThroughWeekKey >= '2026-09-28'),
    'entries older than one full week have expired',
  );
  const expired = w.failures.filter((f) => f.resolvedVia === 'expired');
  assert.ok(expired.length > 0);
  assert.ok(expired.every((f) => f.resolvedAt !== null));
  assert.equal(
    w.failures.length,
    open.length + expired.length,
    'every failure ever written is still present',
  );

  // Skips were granted for each new week, and old grants lapsed rather than vanished.
  assert.equal(w.skips.length, cfg.skipsPerWeek * 4);
  assert.equal(
    w.skips.filter((s) => s.spentAt === null && s.lapsedAt === null).length,
    cfg.skipsPerWeek,
  );
});

test('rollover across a DST transition settles each app-day exactly once', () => {
  const c = onlyTasks(['pray']);
  const spring = rollover(freshWorld('2026-03-06', c), at('2026-03-10', 9, 0, c), c);
  assert.deepEqual(
    spring.failures.map((f) => f.incurredAppDate),
    ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'],
  );
  assert.equal(spring.state.lastSettledAppDate, '2026-03-09');

  const fall = rollover(freshWorld('2026-10-29', c), at('2026-11-02', 9, 0, c), c);
  assert.deepEqual(
    fall.failures.map((f) => f.incurredAppDate),
    ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
  );
  assert.equal(new Set(fall.failures.map((f) => f.id)).size, fall.failures.length);
});

test('a backward clock jump processes nothing and undoes nothing', () => {
  const w = rollover(freshWorld(WEEK1), at('2026-09-09', 9), cfg);
  const before = snapshot(w);

  const back = rollover(w, at('2026-09-08', 9), cfg);
  assert.equal(back, w, 'the same world object is returned');
  assert.equal(snapshot(back), before);

  // When real time catches back up, settlement resumes from the same pointer.
  const forward = rollover(back, at('2026-09-10', 9), cfg);
  assert.equal(forward.state.lastSettledAppDate, '2026-09-09');
});

test('a completion after the day boundary lands in the new app-day', () => {
  const c = onlyTasks(['jobs']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'jobs', WEEK1, { hour: 10, config: c });

  // Opened at 03:00 the next morning: rollover runs first, then the tap.
  const now = at('2026-09-08', 3, 0, c);
  w = rollover(w, now, c);
  w = done(w, 'jobs', '2026-09-08', { hour: 3, minute: 30, config: c });

  const byDay = w.completions.map((x) => x.appDate);
  assert.deepEqual(byDay, [WEEK1, '2026-09-08']);
  assert.equal(
    w.failures.filter((f) => f.incurredAppDate === WEEK1).length,
    0,
    'Monday closed with its completion intact, and the 03:00 tap did not leak back into it',
  );
});
