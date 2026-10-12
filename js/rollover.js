/**
 * rollover.js — the orchestrator.
 *
 * Reads state out of IndexedDB, calls the pure engine, writes the result
 * back. It holds NO scoring logic of its own: every points, penalty, streak,
 * cap and boundary decision comes from scoring.js, and every read and write
 * goes through db.js. If a rule ever appears in this file, it is in the wrong
 * place.
 *
 * The current instant arrives as an argument (`nowMs`) exactly as it does in
 * the engine, so callers stay in control of the clock and tests need no fakes.
 */

import {
  DB_NAME,
  exportDatabase,
  importDatabase,
  inspectImport,
  loadWorld,
  openDatabase,
  persistWorld,
  readMeta,
  seedWorld,
  writeMeta,
} from './db.js';
import { buildView } from './views.js';
import {
  completeTask,
  createWorld,
  rollover as settleForward,
  spendSkip,
  undoCompletion,
} from './scoring.js';

/**
 * Open the database and make sure it holds a world.
 * A fresh install is seeded by the engine, not by hand-written defaults.
 */
export async function openTracker(factory, cfg, nowMs, options = {}) {
  const db = await openDatabase(factory, options.name, options.version);
  let world = await loadWorld(db);
  if (!world) {
    world = await seedWorld(db, createWorld(nowMs, cfg));
  }
  const meta = await readMeta(db);
  return { db, world, meta };
}

/**
 * The single-use reset: wipe every store and come back as a fresh install.
 *
 * The one named exception to never-delete, and narrowly scoped because of it:
 *
 *  - `resetsUsed` is read BEFORE the wipe and written back AFTER, into the
 *    `meta` store of the re-created database. A counter living inside the data
 *    being erased would reset itself, which would make "single use" a lie;
 *  - the allowance comes from `config.resetsAllowed`, never hardcoded;
 *  - callers must have taken an export first — enforced in the UI, since only
 *    it can know the download actually completed.
 *
 * Returns the re-opened database, the fresh world, and the updated meta.
 */
export async function resetEverything(factory, cfg, nowMs, options = {}) {
  const name = options.name ?? DB_NAME;
  const allowed = cfg.resetsAllowed ?? 0;

  const existing = options.db ?? (await openDatabase(factory, name, options.version));
  const meta = await readMeta(existing);
  if (meta.resetsUsed >= allowed) {
    return { ok: false, reason: 'no-resets-left', meta };
  }
  existing.close();

  await new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error ?? new Error('the database refused to delete'));
    req.onblocked = resolve;
  });

  const db = await openDatabase(factory, name, options.version);
  const world = await seedWorld(db, createWorld(nowMs, cfg));
  // Carried across the wipe by hand — this is the whole mechanism.
  const nextMeta = await writeMeta(db, {
    resetsUsed: meta.resetsUsed + 1,
    lastResetAt: nowMs,
  });

  return { ok: true, db, world, meta: nextMeta };
}

export function readTrackerMeta(db) {
  return readMeta(db);
}

/**
 * Settle every elapsed boundary and persist the result.
 *
 * Lazy: this runs on app open, never on a schedule. Idempotent: the engine
 * decides what has already been settled, and only changed rows are written,
 * so a repeated run persists nothing.
 */
export async function runRollover(db, cfg, nowMs, loaded = null) {
  const before = loaded ?? (await loadWorld(db));
  if (!before) throw new Error('rollover before the database was seeded');
  const after = settleForward(before, nowMs, cfg);
  const written = after === before ? 0 : await persistWorld(db, before, after);
  return { world: after, written };
}

/**
 * Run a user action.
 *
 * Rollover always goes first, so a tap made after the day boundary lands in
 * the new app-day with the closing day already settled — and so a rejected
 * action still leaves the elapsed boundaries settled.
 */
async function withRollover(db, cfg, nowMs, apply) {
  const settled = await runRollover(db, cfg, nowMs);
  const result = apply(settled.world);
  if (!result.ok) {
    return { ok: false, reason: result.reason, world: settled.world };
  }
  await persistWorld(db, settled.world, result.world);
  return { ...result, world: result.world };
}

export function completeTaskAction(db, cfg, nowMs, entry) {
  return withRollover(db, cfg, nowMs, (world) =>
    completeTask(world, { timestamp: nowMs, ...entry }, cfg),
  );
}

export function spendSkipAction(db, cfg, nowMs, failureId) {
  return withRollover(db, cfg, nowMs, (world) => spendSkip(world, failureId, nowMs));
}

/**
 * Undo a completion tapped by mistake. Goes through withRollover like every
 * other action, which also means a day that has just closed settles FIRST and
 * the undo is then correctly refused as same-day-only.
 */
export function undoAction(db, cfg, nowMs, completionId) {
  return withRollover(db, cfg, nowMs, (world) => undoCompletion(world, completionId, nowMs, cfg));
}

/**
 * Settle, then hand back the view model every screen renders from.
 *
 * This is the only entry point the ui/ modules use to read: they never touch
 * db.js directly and never derive anything themselves.
 */
export async function loadView(db, cfg, nowMs, extras = {}) {
  const { world } = await runRollover(db, cfg, nowMs);
  return { world, view: buildView(world, nowMs, cfg, extras) };
}

/** The view for a world already in hand — used after an action settles. */
export function viewOf(world, cfg, nowMs, extras = {}) {
  return buildView(world, nowMs, cfg, extras);
}

/** Full JSON export, read straight from the stores. */
export function exportTracker(db, cfg, nowMs) {
  return exportDatabase(db, cfg, nowMs);
}

/**
 * Restore a previously exported dump.
 *
 * Guarded — see db.js. Pass { confirmOverwrite } to import into a database that
 * already holds completions, and { confirmStale } as well when the file is
 * older than what is already stored.
 */
export function importTracker(db, dump, options) {
  return importDatabase(db, dump, options);
}

/** What an import would run into, without writing anything. */
export function inspectTracker(db, dump) {
  return inspectImport(db, dump);
}
