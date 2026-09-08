import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { COLLECTIONS, STORES, loadWorld } from '../js/db.js';
import {
  completeTaskAction,
  exportTracker,
  openTracker,
  runRollover,
  spendSkipAction,
} from '../js/rollover.js';
import { at, cfg, onlyTasks } from './helpers.js';

const WEEK1 = '2026-09-07'; // a Monday
const WEEK2 = '2026-09-14';
const WEEK3 = '2026-09-21';

/** A private in-memory IndexedDB per test — no shared state between them. */
let dbCount = 0;
async function freshDb(config = cfg, appDate = WEEK1, hour = 8) {
  dbCount += 1;
  const factory = new IDBFactory();
  return openTracker(factory, config, at(appDate, hour, 0, config), { name: `test-${dbCount}` });
}

const openFailureRows = (world) => world.failures.filter((f) => f.resolvedAt === null);

test('the database is created with every store and index the schema names', async () => {
  const { db } = await freshDb();
  assert.deepEqual([...db.objectStoreNames].sort(), Object.keys(STORES).sort());

  const tx = db.transaction([...db.objectStoreNames], 'readonly');
  for (const [name, def] of Object.entries(STORES)) {
    const store = tx.objectStore(name);
    assert.equal(store.keyPath, def.keyPath);
    assert.deepEqual([...store.indexNames].sort(), Object.keys(def.indexes).sort());
  }
});

test('a fresh open seeds one state row and the first week of skips', async () => {
  const { db, world } = await freshDb();
  const reloaded = await loadWorld(db);
  assert.equal(reloaded.state.currentWeekKey, WEEK1);
  assert.equal(reloaded.state.balance, 0);
  assert.equal(reloaded.skips.length, cfg.skipsPerWeek);
  assert.deepEqual(reloaded.state, world.state);

  // Re-opening the same database does not re-seed it.
  const again = await loadWorld(db);
  assert.equal(again.skips.length, cfg.skipsPerWeek);
});

test('idempotency end-to-end: a second rollover through IndexedDB writes nothing', async () => {
  const c = onlyTasks(['read', 'jobs', 'gym']);
  const { db } = await freshDb(c);

  // A bonus completion left PENDING, so the settling pass below is the one
  // that banks it — the case a replay must not double-award.
  await completeTaskAction(db, c, at(WEEK1, 9, 0, c), { taskId: 'read' });
  await completeTaskAction(db, c, at(WEEK1, 10, 0, c), { taskId: 'jobs' });
  const beforeRollover = await loadWorld(db);
  assert.equal(beforeRollover.completions.find((x) => x.taskId === 'read').pointsAwarded, null);

  const now = at(WEEK2, 2, 5, c);
  const first = await runRollover(db, c, now);
  assert.ok(first.written > 0, 'the first pass persists the settlement');
  const afterFirst = await loadWorld(db);

  const second = await runRollover(db, c, now);
  assert.equal(second.written, 0, 'a repeated run persists nothing');
  const afterSecond = await loadWorld(db);
  assert.deepEqual(afterSecond, afterFirst, 'the stored state is byte-identical');

  // The pending bonus was banked exactly once.
  const reads = afterSecond.completions.filter((x) => x.taskId === 'read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].pointsAwarded, 8);

  // And a rewound pointer re-settles nothing either.
  const rewound = await loadWorld(db);
  rewound.state.lastProcessedTimestamp = beforeRollover.state.lastProcessedTimestamp;
  const replayed = await runRollover(db, c, now, rewound);
  assert.equal(replayed.world.state.balance, afterFirst.state.balance);
  assert.equal(
    replayed.world.completions.filter((x) => x.taskId === 'read').length,
    1,
    'no duplicate rows and no second award',
  );
  assert.equal(replayed.world.failures.length, afterFirst.failures.length);
});

test('a three-week catch-up settles in one pass, leaving only the last cycle open', async () => {
  const { db } = await freshDb();
  const { world, written } = await runRollover(db, cfg, at('2026-09-30', 9));
  assert.ok(written > 0);

  assert.equal(world.state.currentWeekKey, '2026-09-28', 'three week boundaries crossed');
  const gym = world.failures.filter((f) => f.taskId === 'gym');
  assert.deepEqual(
    [...new Set(gym.map((f) => f.incurredWeekKey))].sort(),
    [WEEK1, WEEK2, WEEK3],
    'each week settled against its own counts',
  );

  const open = openFailureRows(world);
  assert.ok(open.length > 0, 'the most recent cycle is still redeemable');
  assert.ok(
    open.every((f) => f.redeemThroughWeekKey >= '2026-09-28'),
    'anything older than one full week has expired',
  );

  // Persisted, not just in memory — and the expired rows are still there.
  const stored = await loadWorld(db);
  assert.deepEqual(stored.failures.length, world.failures.length);
  const expired = stored.failures.filter((f) => f.resolvedVia === 'expired');
  assert.ok(expired.length > 0);
  assert.equal(
    stored.failures.length,
    expired.length + open.length,
    'every failure ever written is still in the store',
  );
});

test('actions run rollover first, and a rejected action is a complete no-op', async () => {
  const c = onlyTasks(['jobs']);
  const { db } = await freshDb(c);
  await completeTaskAction(db, c, at(WEEK1, 10, 0, c), { taskId: 'jobs' });

  // Opened at 03:00 the next morning: Monday closes, then the tap lands.
  const res = await completeTaskAction(db, c, at('2026-09-08', 3, 0, c), { taskId: 'jobs' });
  assert.equal(res.ok, true);
  assert.equal(res.world.state.lastSettledAppDate, WEEK1, 'the boundary settled first');
  assert.equal(res.completion.appDate, '2026-09-08', 'the tap landed in the new app-day');

  // Spending a skip against an unknown failure changes no record on disk.
  // The settlement pointer still advances — rollover ran, and that is not
  // part of the action being rejected.
  const before = await loadWorld(db);
  const rejected = await spendSkipAction(db, c, at('2026-09-08', 4, 0, c), 'fail:nope:0');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'not-found');

  const after = await loadWorld(db);
  for (const name of ['completions', 'failures', 'skips', 'redemptions', 'missedTargets']) {
    assert.deepEqual(after[name], before[name], `${name} must be untouched by a rejected action`);
  }
  assert.equal(after.state.balance, before.state.balance);
  assert.equal(after.state.currentStreak, before.state.currentStreak);
  assert.equal(after.state.lastSettledAppDate, before.state.lastSettledAppDate);
  assert.ok(after.state.lastProcessedTimestamp > before.state.lastProcessedTimestamp);
});

test('spending a skip persists the resolved failure and the spent token', async () => {
  const c = onlyTasks(['pray']);
  const { db } = await freshDb(c);
  const { world } = await runRollover(db, c, at('2026-09-08', 3, 0, c));
  const target = openFailureRows(world)[0];

  const res = await spendSkipAction(db, c, at('2026-09-08', 9, 0, c), target.id);
  assert.equal(res.ok, true);
  assert.equal(res.refunded, target.actualDeduction);

  const stored = await loadWorld(db);
  const resolved = stored.failures.find((f) => f.id === target.id);
  assert.equal(resolved.resolvedVia, 'skip');
  assert.ok(resolved.resolvedAt !== null);
  assert.ok(stored.skips.some((s) => s.spentOnFailureId === target.id));
  assert.equal(stored.state.balance, world.state.balance + target.actualDeduction);
});

test('export dumps every store, including resolved failures and lapsed skips', async () => {
  const { db } = await freshDb();
  await completeTaskAction(db, cfg, at(WEEK1, 9), { taskId: 'gym' });
  await completeTaskAction(db, cfg, at(WEEK1, 10), { taskId: 'weight', value: 182.4 });
  await completeTaskAction(db, cfg, at(WEEK1, 11), { taskId: 'read' });
  await completeTaskAction(db, cfg, at(WEEK1, 12), { taskId: 'stream' });

  // Far enough forward that a cycle of failures has expired and grants lapsed.
  const { world } = await runRollover(db, cfg, at('2026-09-24', 9));
  const dump = await exportTracker(db, cfg, at('2026-09-24', 9));

  // Every store is present.
  for (const name of [...COLLECTIONS, 'state']) {
    assert.ok(Array.isArray(dump[name]), `${name} missing from the export`);
  }
  assert.equal(dump.state.length, 1);
  assert.equal(dump.configSnapshot, cfg);

  // Nothing was pruned on the way out.
  assert.equal(dump.completions.length, world.completions.length);
  assert.equal(dump.failures.length, world.failures.length);
  assert.equal(dump.skips.length, world.skips.length);

  const expired = dump.failures.filter((f) => f.resolvedVia === 'expired');
  const open = dump.failures.filter((f) => f.resolvedAt === null);
  assert.ok(expired.length > 0, 'expired entries are part of the record');
  assert.ok(open.length > 0);

  const lapsed = dump.skips.filter((s) => s.lapsedAt !== null);
  assert.ok(lapsed.length > 0, 'lapsed skips are part of the record');
  assert.ok(dump.skips.some((s) => s.lapsedAt === null), 'and so are live ones');

  // The weight value survives the round trip, having never affected scoring.
  const weight = dump.completions.find((c) => c.taskId === 'weight');
  assert.equal(weight.value, 182.4);
  assert.equal(weight.unit, 'lbs');
  assert.equal(weight.pointsAwarded, 5, 'points are for the act of recording, not the number');

  // A missed weekly target is recorded as its own thing, never as a failure.
  assert.ok(dump.missedTargets.length > 0);
  assert.ok(dump.failures.every((f) => f.taskId !== 'stream'));

  // The dump is serialisable as-is.
  assert.doesNotThrow(() => JSON.stringify(dump));
});

test('the export survives a reopen of the same database', async () => {
  dbCount += 1;
  const name = `persist-${dbCount}`;
  const factory = new IDBFactory();

  const first = await openTracker(factory, cfg, at(WEEK1, 8), { name });
  await completeTaskAction(first.db, cfg, at(WEEK1, 9), { taskId: 'gym' });
  await runRollover(first.db, cfg, at('2026-09-10', 9));
  const before = await exportTracker(first.db, cfg, at('2026-09-10', 9));
  first.db.close();

  const second = await openTracker(factory, cfg, at('2026-09-10', 9), { name });
  const after = await exportTracker(second.db, cfg, at('2026-09-10', 9));
  assert.deepEqual(after.completions, before.completions);
  assert.deepEqual(after.failures, before.failures);
  assert.deepEqual(after.state, before.state, 'reopening must not re-seed or reset');
});
