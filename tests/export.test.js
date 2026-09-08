import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { COLLECTIONS, ImportRefused, loadWorld, openDatabase } from '../js/db.js';
import {
  completeTaskAction,
  exportTracker,
  importTracker,
  inspectTracker,
  openTracker,
  redeemItemAction,
  runRollover,
  spendSkipAction,
  undoAction,
} from '../js/rollover.js';
import { at, cfg } from './helpers.js';

const WEEK1 = '2026-09-07';

/**
 * A database with something of every kind in it: settled and pending
 * completions, a target bonus, open / redeemed / expired failures, spent and
 * lapsed skips, redemptions, a missed target, and a weight value.
 */
async function loadedTracker(name) {
  const factory = new IDBFactory();
  const { db } = await openTracker(factory, cfg, at('2026-08-24', 7), { name });
  const go = (d, h, taskId, extra = {}) =>
    completeTaskAction(db, cfg, at(d, h), { taskId, ...extra });

  for (const [i, d] of ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'].entries()) {
    await go(d, 7, 'jobs');
    await go(d, 8, 'weight', { value: 185 - i * 0.4 });
    await go(d, 17, 'gym');
    await go(d, 19, 'study');
    await go(d, 20, 'stream');
    if (i === 0) await go(d, 21, 'read');
  }
  await go('2026-08-29', 14, 'chore', { poolLabel: 'Dishes' });
  await redeemItemAction(db, cfg, at('2026-08-30', 18), 'Medium Coke or Sprite');

  // Cross two week boundaries: failures are written, then expire; weekly
  // skip grants lapse; a weekly target is missed.
  const { world } = await runRollover(db, cfg, at('2026-09-16', 9));
  const open = world.failures.find((f) => f.resolvedAt === null);
  await spendSkipAction(db, cfg, at('2026-09-16', 10), open.id);

  return { factory, db, name };
}

test('the export contains every store, with nothing pruned by state', async () => {
  const { db } = await loadedTracker('export-shape');
  const dump = await exportTracker(db, cfg, at('2026-09-16', 11));

  for (const store of [...COLLECTIONS, 'state']) {
    assert.ok(Array.isArray(dump[store]), `${store} missing`);
    assert.ok(dump[store].length > 0, `${store} is empty — the fixture should have exercised it`);
  }

  // Completions include a synthetic target-bonus record.
  assert.ok(dump.completions.some((c) => c.taskType === 'target-bonus' && c.id.startsWith('tb:')));
  // ...and a still-pending bonus is exported as pending, not as a zero.
  assert.ok(dump.completions.some((c) => c.taskType === 'bonus'));
  // ...and the weight value round-trips as a value.
  assert.equal(dump.completions.find((c) => c.taskId === 'weight').value, 185);

  // Failures in all three states.
  assert.ok(dump.failures.some((f) => f.resolvedAt === null), 'open');
  assert.ok(dump.failures.some((f) => f.resolvedVia === 'skip'), 'redeemed');
  assert.ok(dump.failures.some((f) => f.resolvedVia === 'expired'), 'expired');

  // Skips in all three states.
  assert.ok(dump.skips.some((s) => s.spentAt === null && s.lapsedAt === null), 'available');
  assert.ok(dump.skips.some((s) => s.spentAt !== null), 'spent');
  assert.ok(dump.skips.some((s) => s.lapsedAt !== null), 'lapsed');

  assert.ok(dump.missedTargets.length > 0);
  assert.ok(dump.redemptions.length > 0);
  assert.equal(dump.state.length, 1);
  assert.equal(dump.configSnapshot, cfg);
  assert.doesNotThrow(() => JSON.stringify(dump));
});

test('export → wipe → reimport restores byte-identical state', async () => {
  const { factory, db, name } = await loadedTracker('roundtrip');
  const before = await exportTracker(db, cfg, at('2026-09-16', 11));
  const worldBefore = await loadWorld(db);
  db.close();

  // Wipe: the whole database goes, which is the one deliberate destructive act
  // in the app and lives at the call site, never inside db.js.
  await new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = resolve;
    req.onerror = reject;
    req.onblocked = resolve;
  });

  const empty = await openDatabase(factory, name);
  assert.equal(await loadWorld(empty), null, 'the wipe really emptied it');

  const restored = await importTracker(empty, before);
  assert.ok(restored > 0);

  const worldAfter = await loadWorld(empty);
  assert.deepEqual(worldAfter, worldBefore, 'every row and the state row came back identical');

  // Exporting again produces the same dump, so the round trip is stable.
  const after = await exportTracker(empty, cfg, at('2026-09-16', 11));
  assert.deepEqual(after, before);
});

test('a restored database keeps settling from where it left off', async () => {
  const { factory, db, name } = await loadedTracker('resume');
  const dump = await exportTracker(db, cfg, at('2026-09-16', 11));
  db.close();

  await new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = resolve; req.onerror = reject; req.onblocked = resolve;
  });
  const fresh = await openDatabase(factory, name);
  await importTracker(fresh, dump);

  // Settling forward from the restored pointer behaves exactly as it would
  // have before the wipe: no re-settlement of days already closed.
  const settled = await runRollover(fresh, cfg, at('2026-09-18', 9));
  assert.equal(settled.world.state.lastSettledAppDate, '2026-09-17');
  assert.equal(
    settled.world.completions.filter((c) => c.id.startsWith('tb:')).length,
    dump.completions.filter((c) => c.id.startsWith('tb:')).length,
    'no duplicate target bonuses after a restore',
  );
});

test('completing a task still works against a restored database', async () => {
  const { factory, db, name } = await loadedTracker('resume-actions');
  const dump = await exportTracker(db, cfg, at('2026-09-16', 11));
  db.close();

  await new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = resolve; req.onerror = reject; req.onblocked = resolve;
  });
  const fresh = await openDatabase(factory, name);
  await importTracker(fresh, dump);

  const res = await completeTaskAction(fresh, cfg, at('2026-09-17', 10), { taskId: 'gym' });
  assert.equal(res.ok, true);
  assert.ok(res.completion.pointsAwarded > 0);
  const stored = await loadWorld(fresh);
  assert.ok(stored.completions.some((c) => c.id === res.completion.id));
});

/* ------------------------------------------------------------------ *
 * Import guard                                                        *
 * ------------------------------------------------------------------ */

test('import refuses a schema-version mismatch outright', async () => {
  const { factory, db, name } = await loadedTracker('guard-schema');
  const dump = await exportTracker(db, cfg, at('2026-09-16', 11));
  db.close();

  await new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = resolve; req.onerror = reject; req.onblocked = resolve;
  });
  const fresh = await openDatabase(factory, name);

  for (const version of [2, 0, undefined]) {
    const wrong = { ...dump, schemaVersion: version };
    const err = await importTracker(fresh, wrong).then(() => null, (e) => e);
    assert.ok(err instanceof ImportRefused, `version ${version} should be refused`);
    assert.equal(err.code, 'schema-mismatch');
    assert.match(err.message, new RegExp(`version ${version ?? 'unknown'}`));
    assert.match(err.message, /version 1/);
  }

  // Not waivable: confirming everything still refuses.
  const err = await importTracker(fresh, { ...dump, schemaVersion: 9 },
    { confirmOverwrite: true, confirmStale: true }).then(() => null, (e) => e);
  assert.equal(err.code, 'schema-mismatch');
  assert.equal(await loadWorld(fresh), null, 'nothing was written');
});

test('import into a database with completions refuses until confirmed, naming both worlds', async () => {
  const { db } = await loadedTracker('guard-occupied');
  // A smaller, older backup of the same history.
  const older = await exportTracker(db, cfg, at('2026-09-16', 11));
  older.completions = older.completions.slice(0, 3);

  const err = await importTracker(db, older).then(() => null, (e) => e);
  assert.ok(err instanceof ImportRefused);
  assert.equal(err.code, 'target-not-empty');

  // The message must carry both sides' numbers and dates.
  const target = err.summary.target;
  const file = err.summary.file;
  assert.ok(target.completions > file.completions);
  assert.match(err.message, new RegExp(`This database has ${target.completions} completions through ${target.through}`));
  assert.match(err.message, new RegExp(`the file has ${file.completions} completions through ${file.through}`));

  // Confirming lets it through.
  const before = await loadWorld(db);
  const ok = await importTracker(db, older, { confirmOverwrite: true });
  assert.ok(ok > 0);
  const after = await loadWorld(db);
  assert.equal(after.completions.length, before.completions.length, 'a merge by id, not a wipe');
});

test('import refuses a file older than the database unless separately confirmed', async () => {
  const { factory, db, name } = await loadedTracker('guard-stale');
  const stale = await exportTracker(db, cfg, at('2026-09-16', 11));
  db.close();

  // A database that has moved on past the backup.
  await new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = resolve; req.onerror = reject; req.onblocked = resolve;
  });
  const moved = await openDatabase(factory, name);
  await importTracker(moved, stale);
  await completeTaskAction(moved, cfg, at('2026-09-20', 10), { taskId: 'gym' });

  const err = await importTracker(moved, stale, { confirmOverwrite: true }).then(() => null, (e) => e);
  assert.ok(err instanceof ImportRefused);
  assert.equal(err.code, 'stale-file', 'confirming the overwrite must not waive staleness');
  assert.match(err.message, /older than this database/);
  assert.ok(err.summary.file.newestInstant < err.summary.target.newestInstant);

  // Both confirmations together proceed.
  const restored = await importTracker(moved, stale, { confirmOverwrite: true, confirmStale: true });
  assert.ok(restored > 0);
});

test('inspectImport reports without writing, and a fresh restore needs no confirmation', async () => {
  const { factory, db, name } = await loadedTracker('guard-inspect');
  const dump = await exportTracker(db, cfg, at('2026-09-16', 11));
  db.close();

  await new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = resolve; req.onerror = reject; req.onblocked = resolve;
  });
  const fresh = await openDatabase(factory, name);

  const report = await inspectTracker(fresh, dump);
  assert.equal(report.ok, true, 'an empty database takes a matching backup unprompted');
  assert.deepEqual(report.blocking, []);
  assert.deepEqual(report.needsConfirmation, []);
  assert.equal(report.target.completions, 0);
  assert.ok(report.file.completions > 0);
  assert.equal(await loadWorld(fresh), null, 'inspecting wrote nothing');

  assert.ok(await importTracker(fresh, dump) > 0);
});

test('the export includes voided completions', async () => {
  const factory = new IDBFactory();
  const { db } = await openTracker(factory, cfg, at('2026-09-07', 7), { name: 'export-voided' });

  await completeTaskAction(db, cfg, at('2026-09-07', 9), { taskId: 'jobs' });
  const kept = await completeTaskAction(db, cfg, at('2026-09-07', 10), { taskId: 'gym' });
  const mistake = await completeTaskAction(db, cfg, at('2026-09-07', 11), { taskId: 'gym' });

  const undone = await undoAction(db, cfg, at('2026-09-07', 12), mistake.completion.id);
  assert.equal(undone.ok, true);

  const dump = await exportTracker(db, cfg, at('2026-09-07', 13));
  const voided = dump.completions.find((c) => c.id === mistake.completion.id);

  assert.ok(voided, 'a voided completion is still in the export — undo marks, never deletes');
  assert.ok(voided.voidedAt > 0);
  assert.equal(voided.voidedRefund, mistake.completion.pointsAwarded);
  assert.equal(voided.pointsAwarded, mistake.completion.pointsAwarded, 'what it paid at the time');

  // ...alongside the live ones, distinguishable by the field alone.
  const live = dump.completions.filter((c) => !c.voidedAt);
  assert.equal(live.length, 2);
  assert.ok(live.some((c) => c.id === kept.completion.id));
  assert.equal(dump.completions.length, 3, 'every tap ever made is present');
});
