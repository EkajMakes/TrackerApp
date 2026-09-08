import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anchoredOn,
  bonusHeadroom,
  completionsOfTaskInWeek,
  completionsOfTaskOnDay,
  pendingSummary,
  rollover,
  undoCompletion,
  undosRemaining,
} from '../js/scoring.js';
import { at, done, freshWorld, onlyTasks, snapshot } from './helpers.js';

const WEEK1 = '2026-09-07'; // a Monday
const TOMORROW = '2026-09-08';

test('undo refunds exactly pointsAwarded and never more', () => {
  const c = onlyTasks(['gym', 'jobs']);
  let w = freshWorld(WEEK1, c);
  const before = w.state.balance;

  w = done(w, 'gym', WEEK1, { hour: 10, config: c });
  const completion = w.completions.at(-1);
  const awarded = completion.pointsAwarded;
  assert.equal(awarded, 15);
  assert.equal(w.state.balance, before + awarded);

  const res = undoCompletion(w, completion.id, at(WEEK1, 11, 0, c), c);
  assert.equal(res.ok, true);
  assert.equal(res.refunded, awarded, 'exactly what was banked, read off the record');
  assert.equal(res.world.state.balance, before, 'and never above where it started');

  // The record survives, marked rather than removed.
  const voided = res.world.completions.find((x) => x.id === completion.id);
  assert.ok(voided, 'never deleted');
  assert.equal(voided.voidedAt, at(WEEK1, 11, 0, c));
  assert.equal(voided.voidedRefund, awarded);
  assert.equal(voided.pointsAwarded, awarded, 'history keeps what it paid at the time');
});

test('undo never uses the current tier to recompute the refund', () => {
  const c = onlyTasks(['jobs']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'jobs', WEEK1, { hour: 9, config: c });
  const completion = w.completions.at(-1);

  // A tier change between the tap and the undo must not change the refund.
  w.state.currentStreak = 30;
  const res = undoCompletion(w, completion.id, at(WEEK1, 20, 0, c), c);
  assert.equal(res.refunded, completion.pointsAwarded);
  assert.equal(res.world.state.balance, 0);
});

test('undo of an unsettled bonus refunds nothing and restores headroom', () => {
  const c = onlyTasks(['read', 'jobs']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'jobs', WEEK1, { hour: 9, config: c });
  const balanceBefore = w.state.balance;
  const headroomBefore = bonusHeadroom(w, WEEK1, c);

  w = done(w, 'read', WEEK1, { hour: 10, config: c });
  const bonus = w.completions.at(-1);
  assert.equal(bonus.pointsAwarded, null, 'unsettled until day close');
  assert.ok(pendingSummary(w, at(WEEK1, 11, 0, c), c).pending > 0);

  const res = undoCompletion(w, bonus.id, at(WEEK1, 11, 0, c), c);
  assert.equal(res.ok, true);
  assert.equal(res.refunded, 0, 'nothing was banked, so nothing comes back');
  assert.equal(res.world.state.balance, balanceBefore);
  assert.equal(bonusHeadroom(res.world, WEEK1, c), headroomBefore, 'headroom returned');
  assert.equal(pendingSummary(res.world, at(WEEK1, 11, 0, c), c).pending, 0);

  // And it does not settle at day close either.
  const closed = rollover(res.world, at(TOMORROW, 3, 0, c), c);
  const still = closed.completions.find((x) => x.id === bonus.id);
  assert.equal(still.pointsAwarded, null, 'a voided bonus is never settled');
});

test('undo after the day boundary is rejected as a complete no-op', () => {
  const c = onlyTasks(['gym', 'jobs']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'gym', WEEK1, { hour: 10, config: c });
  const completion = w.completions.at(-1);

  w = rollover(w, at(TOMORROW, 3, 0, c), c); // the day has closed
  const before = snapshot(w);

  const res = undoCompletion(w, completion.id, at(TOMORROW, 9, 0, c), c);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'day-closed');
  assert.equal(res.world, w, 'the same world object is returned');
  assert.equal(snapshot(res.world), before, 'no balance move, no allowance spent');
});

test('the fourth undo in one app-day is rejected as a complete no-op', () => {
  const c = onlyTasks(['chore', 'jobs'], (raw) => { raw.tasks.chore.dailyCap = 6; });
  assert.equal(c.undosPerDay, 3, 'the allowance comes from config, not from code');

  let w = freshWorld(WEEK1, c);
  w = done(w, 'jobs', WEEK1, { hour: 8, config: c });
  for (const hour of [9, 10, 11, 12]) {
    w = done(w, 'chore', WEEK1, { hour, config: c, poolLabel: 'Dishes' });
  }
  const ids = w.completions.filter((x) => x.taskId === 'chore').map((x) => x.id);

  for (const [i, id] of ids.slice(0, 3).entries()) {
    assert.equal(undosRemaining(w, at(WEEK1, 13, 0, c), c), 3 - i);
    const res = undoCompletion(w, id, at(WEEK1, 13, 0, c), c);
    assert.equal(res.ok, true, `undo ${i + 1} should be allowed`);
    w = res.world;
  }

  assert.equal(undosRemaining(w, at(WEEK1, 13, 0, c), c), 0);
  const before = snapshot(w);
  const fourth = undoCompletion(w, ids[3], at(WEEK1, 14, 0, c), c);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'no-undos-left');
  assert.equal(fourth.world, w);
  assert.equal(snapshot(fourth.world), before);
});

test('the undo allowance resets at the day boundary', () => {
  const c = onlyTasks(['chore', 'jobs'], (raw) => { raw.tasks.chore.dailyCap = 6; });
  let w = freshWorld(WEEK1, c);
  w = done(w, 'jobs', WEEK1, { hour: 8, config: c });
  for (const hour of [9, 10, 11]) {
    w = done(w, 'chore', WEEK1, { hour, config: c, poolLabel: 'Trash' });
  }
  for (const id of w.completions.filter((x) => x.taskId === 'chore').map((x) => x.id)) {
    w = undoCompletion(w, id, at(WEEK1, 12, 0, c), c).world;
  }
  assert.equal(undosRemaining(w, at(WEEK1, 13, 0, c), c), 0);

  w = rollover(w, at(TOMORROW, 3, 0, c), c);
  assert.equal(undosRemaining(w, at(TOMORROW, 9, 0, c), c), 3, 'a fresh allowance the next day');

  // And it is spendable again on the new day's completions.
  w = done(w, 'jobs', TOMORROW, { hour: 9, config: c });
  const fresh = w.completions.at(-1);
  assert.equal(undoCompletion(w, fresh.id, at(TOMORROW, 10, 0, c), c).ok, true);
});

test('voided completions are excluded from quota, daily, anchor and streak', () => {
  const c = onlyTasks(['gym', 'jobs', 'pray']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'gym', WEEK1, { hour: 9, config: c });
  w = done(w, 'gym', WEEK1, { hour: 10, config: c });
  w = done(w, 'jobs', WEEK1, { hour: 11, config: c });
  w = done(w, 'pray', WEEK1, { hour: 12, config: c });

  assert.equal(completionsOfTaskInWeek(w, 'gym', WEEK1).length, 2);
  assert.equal(completionsOfTaskOnDay(w, 'jobs', WEEK1).length, 1);
  assert.equal(anchoredOn(w, WEEK1, c), true);

  // Void one gym (quota count) and jobs (daily count).
  const [gymOne, gymTwo] = w.completions.filter((x) => x.taskId === 'gym');
  const jobs = w.completions.find((x) => x.taskId === 'jobs');
  w = undoCompletion(w, gymOne.id, at(WEEK1, 13, 0, c), c).world;
  w = undoCompletion(w, jobs.id, at(WEEK1, 13, 30, c), c).world;

  assert.equal(completionsOfTaskInWeek(w, 'gym', WEEK1).length, 1, 'quota count drops');
  assert.equal(completionsOfTaskOnDay(w, 'jobs', WEEK1).length, 0, 'daily count drops');
  // gym is an anchor too, so the day is still anchored by the surviving one.
  assert.equal(anchoredOn(w, WEEK1, c), true, 'one anchor left is still an anchor');

  // Void the last anchor as well; pray is not one, so the day is now unanchored.
  w = undoCompletion(w, gymTwo.id, at(WEEK1, 14, 0, c), c).world;
  assert.equal(completionsOfTaskInWeek(w, 'gym', WEEK1).length, 0);
  assert.equal(anchoredOn(w, WEEK1, c), false, 'anchor status drops with the last one');

  const closed = rollover(w, at(TOMORROW, 3, 0, c), c);
  assert.equal(closed.state.currentStreak, 0, 'a day whose only anchor was undone breaks the streak');
  // The daily miss is now real, because the completion no longer counts.
  assert.ok(closed.failures.some((f) => f.taskId === 'jobs' && f.incurredAppDate === WEEK1));
});

test('voiding the only anchor re-locks the day and flips pending to locked', () => {
  const c = onlyTasks(['read', 'jobs']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'read', WEEK1, { hour: 9, config: c });
  w = done(w, 'jobs', WEEK1, { hour: 10, config: c });

  const now = at(WEEK1, 11, 0, c);
  assert.equal(pendingSummary(w, now, c).locked, false);

  const jobs = w.completions.find((x) => x.taskId === 'jobs');
  const res = undoCompletion(w, jobs.id, now, c);
  const view = pendingSummary(res.world, now, c);
  assert.equal(view.locked, true, 'the bonus tiles re-lock');
  assert.equal(view.anchoredToday, false);
  assert.ok(view.pending > 0, 'still pending, but now shown as locked');
});

test('a voided completion does not consume a second undo if re-submitted', () => {
  const c = onlyTasks(['gym', 'jobs']);
  let w = freshWorld(WEEK1, c);
  w = done(w, 'gym', WEEK1, { hour: 9, config: c });
  const completion = w.completions.at(-1);

  const first = undoCompletion(w, completion.id, at(WEEK1, 10, 0, c), c);
  assert.equal(first.ok, true);
  assert.equal(undosRemaining(first.world, at(WEEK1, 10, 0, c), c), 2);

  const before = snapshot(first.world);
  const again = undoCompletion(first.world, completion.id, at(WEEK1, 11, 0, c), c);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-voided');
  assert.equal(again.world, first.world);
  assert.equal(snapshot(again.world), before, 'no double refund, no second undo spent');
  assert.equal(undosRemaining(again.world, at(WEEK1, 11, 0, c), c), 2);
});

test('undosPerDay of 0 disables undo entirely', () => {
  const c = onlyTasks(['gym'], (raw) => { raw.undosPerDay = 0; });
  let w = freshWorld(WEEK1, c);
  w = done(w, 'gym', WEEK1, { hour: 9, config: c });
  const res = undoCompletion(w, w.completions.at(-1).id, at(WEEK1, 10, 0, c), c);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-undos-left');
});
