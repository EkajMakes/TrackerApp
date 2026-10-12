import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { DB_VERSION, loadWorld, openDatabase, readMeta } from '../js/db.js';
import {
  completeTaskAction,
  exportTracker,
  openTracker,
  resetEverything,
  runRollover,
} from '../js/rollover.js';
import { at, cfg, makeConfig } from './helpers.js';

const WEEK1 = '2026-09-07';

async function livedIn(name, factory) {
  const { db } = await openTracker(factory, cfg, at('2026-09-07', 7), { name });
  await completeTaskAction(db, cfg, at(WEEK1, 9), { taskId: 'jobs' });
  await completeTaskAction(db, cfg, at(WEEK1, 10), { taskId: 'gym' });
  await runRollover(db, cfg, at('2026-09-12', 9));
  return db;
}

/* ------------------------------------------------------------------ *
 * The v1 → v2 migration                                               *
 * ------------------------------------------------------------------ */

/** A v1 database, shaped the way stage 5 left it, with redemptions in it. */
function openV1(factory, name) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of ['completions', 'failures', 'skips', 'redemptions', 'missedTargets', 'state']) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

test('existing redemption rows survive the schema bump into archive', async () => {
  const factory = new IDBFactory();
  const name = 'migrate-v1';

  const v1 = await openV1(factory, name);
  const tx = v1.transaction(['redemptions', 'state'], 'readwrite');
  const rows = [
    { id: 'rdm:1', itemName: 'Big Mac', cost: 200, timestamp: 1757000000000, balanceAfter: 140 },
    { id: 'rdm:2', itemName: 'Skip Token', cost: 250, timestamp: 1757100000000, balanceAfter: 10 },
    { id: 'rdm:3', itemName: 'Movie', cost: 300, timestamp: 1757200000000, balanceAfter: 55 },
  ];
  for (const row of rows) tx.objectStore('redemptions').put(row);
  tx.objectStore('state').put({ id: 'app', balance: 55, currentStreak: 2, lastProcessedTimestamp: 1 });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  v1.close();

  // Opening at the current version runs the migration.
  const db = await openDatabase(factory, name);
  assert.equal(db.version, DB_VERSION);
  assert.ok(!db.objectStoreNames.contains('redemptions'), 'the cut store is gone');
  assert.ok(db.objectStoreNames.contains('archive'), 'and its rows have somewhere to be');

  const world = await loadWorld(db);
  assert.equal(world.archive.length, 3, 'every redemption was carried across');

  for (const original of rows) {
    const kept = world.archive.find((a) => a.id === `archive:redemptions:${original.id}`);
    assert.ok(kept, `${original.id} was lost in the migration`);
    assert.equal(kept.store, 'redemptions');
    assert.deepEqual(kept.row, original, 'the row is preserved verbatim, not summarised');
    assert.match(kept.archivedBecause, /shop/);
  }

  // And the rescued rows ride along in the export, which is the whole point.
  const dump = await exportTracker(db, cfg, at(WEEK1, 12));
  assert.equal(dump.archive.length, 3);
  assert.ok(dump.archive.every((a) => a.row.itemName));
});

test('a fresh v2 database has an empty archive and no redemptions store', async () => {
  const factory = new IDBFactory();
  const { db, world } = await openTracker(factory, cfg, at(WEEK1, 7), { name: 'fresh-v2' });
  assert.ok(!db.objectStoreNames.contains('redemptions'));
  assert.deepEqual(world.archive, []);
});

/* ------------------------------------------------------------------ *
 * The single-use reset                                                *
 * ------------------------------------------------------------------ */

test('reset preserves resetsUsed through the wipe and refuses a second use', async () => {
  const factory = new IDBFactory();
  const name = 'single-use';
  const db = await livedIn(name, factory);

  const before = await loadWorld(db);
  assert.ok(before.completions.length > 0);
  assert.ok(before.failures.length > 0);
  assert.equal((await readMeta(db)).resetsUsed, 0, 'nothing used yet');

  // First reset: allowed.
  const first = await resetEverything(factory, cfg, at('2026-09-12', 10), { db, name });
  assert.equal(first.ok, true);
  assert.equal(first.world.completions.length, 0, 'the data is gone');
  assert.equal(first.world.failures.length, 0);
  assert.equal(first.world.state.balance, 0);
  assert.equal(first.world.skips.length, cfg.skipsPerWeek, 'reseeded as a fresh install');

  // THE point: the counter outlived the wipe that erased everything else.
  assert.equal(first.meta.resetsUsed, 1, 'the counter survived its own reset');
  assert.equal((await readMeta(first.db)).resetsUsed, 1, 'and it is on disk, not just in hand');

  // Second reset: refused, and nothing is touched.
  await completeTaskAction(first.db, cfg, at('2026-09-12', 11), { taskId: 'gym' });
  const populated = await loadWorld(first.db);

  const second = await resetEverything(factory, cfg, at('2026-09-12', 12), { db: first.db, name });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'no-resets-left');
  assert.equal(second.meta.resetsUsed, 1, 'and the count did not creep');

  const after = await loadWorld(first.db);
  assert.deepEqual(after, populated, 'the refused reset changed nothing at all');
});

test('the allowance comes from config, not from code', async () => {
  const twice = makeConfig((raw) => { raw.resetsAllowed = 2; });
  const factory = new IDBFactory();
  const name = 'two-resets';
  const db = await livedIn(name, factory);

  const first = await resetEverything(factory, twice, at('2026-09-12', 10), { db, name });
  assert.equal(first.ok, true);
  const second = await resetEverything(factory, twice, at('2026-09-12', 11), { db: first.db, name });
  assert.equal(second.ok, true, 'a config allowing two gets two');
  assert.equal(second.meta.resetsUsed, 2);

  const third = await resetEverything(factory, twice, at('2026-09-12', 12), { db: second.db, name });
  assert.equal(third.ok, false, 'and no more than two');
});

test('resetsAllowed of 0 refuses from the start', async () => {
  const never = makeConfig((raw) => { raw.resetsAllowed = 0; });
  const factory = new IDBFactory();
  const name = 'no-resets';
  const db = await livedIn(name, factory);
  const before = await loadWorld(db);

  const res = await resetEverything(factory, never, at('2026-09-12', 10), { db, name });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-resets-left');

  const reopened = await openDatabase(factory, name);
  assert.deepEqual(await loadWorld(reopened), before, 'the data is untouched');
});

test('the export still dumps every store, archive and meta included', async () => {
  const factory = new IDBFactory();
  const name = 'export-shape-v2';
  const db = await livedIn(name, factory);
  await resetEverything(factory, cfg, at('2026-09-12', 10), { db, name });

  const reopened = await openDatabase(factory, name);
  const dump = await exportTracker(reopened, cfg, at('2026-09-12', 11));

  for (const store of ['completions', 'failures', 'skips', 'missedTargets', 'archive', 'meta', 'state']) {
    assert.ok(Array.isArray(dump[store]), `${store} is missing from the export`);
  }
  assert.equal(dump.meta.length, 1, 'and meta carries the reset count out with it');
  assert.equal(dump.meta[0].resetsUsed, 1);
  assert.equal(dump.schemaVersion, DB_VERSION);
  assert.doesNotThrow(() => JSON.stringify(dump));
});
