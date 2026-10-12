import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError } from '../js/config.js';
import { award, nextTierFor, records, rollover, streakRuns, tierFor } from '../js/scoring.js';
import { at, cfg, done, freshWorld, makeConfig, onlyTasks } from './helpers.js';

/* ------------------------------------------------------------------ *
 * The seven-tier ladder                                               *
 * ------------------------------------------------------------------ */

test('the multiplier is exact at every checkpoint, cap included', () => {
  const expected = [
    [0, 'Cold', 1.0],
    [1, 'Spark', 1.05],
    [2, 'Embers', 1.1],
    [3, 'Blaze', 1.15],
    [4, 'Burning', 1.2],
    [5, 'Inferno', 1.3],
    [6, 'Primal Burn', 1.4],
    [7, 'Conflagration', 1.5],   // the open-ended rung opens here
    [8, 'Conflagration', 1.52],
    [20, 'Conflagration', 1.76], // 1.50 + 13 * 0.02
    [56, 'Conflagration', 2.48],
    [57, 'Conflagration', 2.5],  // the cap, exactly
    [100, 'Conflagration', 2.5], // and it stays there
  ];

  for (const [streak, name, multiplier] of expected) {
    const tier = tierFor(streak, cfg);
    assert.equal(tier.name, name, `streak ${streak} should be ${name}`);
    assert.equal(tier.multiplier, multiplier, `streak ${streak} should pay ${multiplier}x`);
  }
});

test('above the top tier the multiplier climbs by exactly perDay and never passes max', () => {
  const { perDay, max } = cfg.streak.beyondTopTier;
  const top = cfg.streak.tiers.at(-1);

  let previous = null;
  for (let streak = top.at; streak <= 200; streak += 1) {
    const { multiplier } = tierFor(streak, cfg);
    assert.ok(multiplier <= max, `streak ${streak} exceeded the cap at ${multiplier}`);
    if (previous !== null && previous < max) {
      const step = Math.round((multiplier - previous) * 100) / 100;
      assert.ok(
        step === perDay || multiplier === max,
        `streak ${streak} stepped by ${step}, not ${perDay}`,
      );
    }
    previous = multiplier;
  }
  assert.equal(tierFor(200, cfg).multiplier, max, 'and it is still pinned at the cap');
});

test('the ladder reports what the UI needs to say', () => {
  const mid = tierFor(3, cfg);
  assert.equal(mid.beyond, false);
  assert.equal(mid.nextDayMultiplier, null);
  assert.equal(nextTierFor(3, cfg).name, 'Burning');

  const climbing = tierFor(12, cfg);
  assert.equal(climbing.beyond, true);
  assert.equal(climbing.daysIntoTier, 5, 'day 12 is the sixth day of Conflagration');
  assert.equal(climbing.atCap, false);
  assert.equal(climbing.nextDayMultiplier, 1.62, 'tomorrow is +0.02');
  assert.equal(nextTierFor(12, cfg), null, 'there is no named rung above it');

  const capped = tierFor(80, cfg);
  assert.equal(capped.atCap, true);
  assert.equal(capped.nextDayMultiplier, capped.multiplier, 'tomorrow pays the same');
});

test('awards use the ladder, and penalties never do', () => {
  assert.equal(award(15, tierFor(0, cfg)), 15);
  assert.equal(award(15, tierFor(7, cfg)), 23);  // 15 * 1.50
  assert.equal(award(15, tierFor(57, cfg)), 38); // 15 * 2.50
});

test('config rejects a tier ladder that does not start at 0', () => {
  assert.throws(
    () => makeConfig((raw) => { raw.streak.tiers[0].at = 1; }),
    (err) => err instanceof ConfigError && /must start at 0/.test(err.message),
  );
});

test('config rejects a shop key', () => {
  assert.throws(
    () => makeConfig((raw) => { raw.shop = []; }),
    (err) => err instanceof ConfigError && /no longer supported/.test(err.message),
  );
  assert.throws(
    () => makeConfig((raw) => { raw.shop = [{ name: 'Big Mac', cost: 200 }]; }),
    ConfigError,
  );
});

/* ------------------------------------------------------------------ *
 * Records                                                             *
 * ------------------------------------------------------------------ */

/** A ledger of anchored days, built without walking a year of rollovers. */
function ledgerOf(days, config = cfg, extra = {}) {
  return {
    state: { currentStreak: 0, balance: 0, ...extra },
    completions: days.map((appDate, i) => ({
      id: `cmp:gym:${appDate}:${i}`,
      taskId: 'gym',
      taskType: 'quota',
      appDate,
      weekKey: '2026-09-07',
      pointsAwarded: 15,
      voidedAt: null,
    })),
    failures: [],
    skips: [],
    missedTargets: [],
    archive: [],
  };
}

const range = (start, count) => {
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1, d + i));
    return date.toISOString().slice(0, 10);
  });
};

test('records come out of a ledger with several broken streaks', () => {
  // Three runs: 4 days, 11 days, 2 days — with real gaps between them.
  const days = [
    ...range('2026-06-01', 4),
    ...range('2026-06-10', 11),
    ...range('2026-07-01', 2),
  ];
  const world = ledgerOf(days, cfg, { currentStreak: 2 });
  const runs = streakRuns(world, cfg);
  assert.deepEqual(runs.map((r) => r.length), [4, 11, 2], 'each unbroken run is found');

  const r = records(world, cfg);
  assert.equal(r.longestStreak.days, 11);
  assert.equal(r.longestStreak.start, '2026-06-10');
  assert.equal(r.longestStreak.end, '2026-06-20');
  assert.equal(r.longestStreak.tierName, 'Conflagration', 'an 11-day run reached the top rung');
  assert.equal(r.current, 2);
  assert.equal(r.behindRecordBy, 9);
  assert.equal(r.isRecordNow, false);
});

test('the Conflagration record counts only the consecutive days at 7+', () => {
  // An 11-day run spends days 7..11 at the top rung: five days, not eleven.
  const world = ledgerOf(range('2026-06-10', 11));
  assert.equal(records(world, cfg).longestTopTierRun.days, 5);

  // A 6-day run never reaches it at all.
  assert.equal(records(ledgerOf(range('2026-06-01', 6)), cfg).longestTopTierRun.days, 0);

  // Exactly 7 days is one day at the rung.
  assert.equal(records(ledgerOf(range('2026-06-01', 7)), cfg).longestTopTierRun.days, 1);

  // Two separate 8-day runs do not add up to 4.
  const twoRuns = ledgerOf([...range('2026-06-01', 8), ...range('2026-07-01', 8)]);
  assert.equal(records(twoRuns, cfg).longestTopTierRun.days, 2, 'the LONGEST run, not the total');
});

test('a voided completion can cost you the record', () => {
  const world = ledgerOf(range('2026-06-01', 5));
  assert.equal(records(world, cfg).longestStreak.days, 5);

  // Undo the middle day: the run splits into 2 + 2.
  world.completions[2].voidedAt = Date.now();
  const after = records(world, cfg);
  assert.equal(after.longestStreak.days, 2, 'voided days break the run like any other gap');
});

test('the current streak standing at the record reads as a record', () => {
  const world = ledgerOf(range('2026-06-01', 6), cfg, { currentStreak: 6 });
  const r = records(world, cfg);
  assert.equal(r.isRecordNow, true);
  assert.equal(r.behindRecordBy, 0);
});

test('best week is the highest net, not the highest earned', () => {
  const world = ledgerOf(range('2026-06-01', 2));
  world.completions[0].weekKey = '2026-06-01';
  world.completions[1].weekKey = '2026-06-08';
  // The bigger earner also took the bigger beating.
  world.completions[0].pointsAwarded = 200;
  world.completions[1].pointsAwarded = 120;
  world.failures = [
    { id: 'f1', incurredWeekKey: '2026-06-01', actualDeduction: 150, resolvedVia: null },
    { id: 'f2', incurredWeekKey: '2026-06-08', actualDeduction: 10, resolvedVia: null },
  ];
  const r = records(world, cfg);
  assert.equal(r.bestWeek.weekKey, '2026-06-08');
  assert.equal(r.bestWeek.net, 110);
});

test('records survive a real rollover, not just a synthetic ledger', () => {
  const c = onlyTasks(['jobs']);
  let w = freshWorld('2026-09-07', c);
  for (const day of range('2026-09-07', 8)) {
    w = done(w, 'jobs', day, { hour: 10, config: c });
    w = rollover(w, at(day, 23, 59, c) + 3 * 3600000, c);
  }
  const r = records(w, c);
  assert.equal(r.longestStreak.days, 8);
  assert.equal(r.longestTopTierRun.days, 2, 'days 7 and 8 sat at Conflagration');
  assert.equal(w.state.currentStreak, 8);
  assert.equal(tierFor(w.state.currentStreak, c).multiplier, 1.52);
});
