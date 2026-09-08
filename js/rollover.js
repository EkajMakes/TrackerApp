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
  exportDatabase,
  importDatabase,
  inspectImport,
  loadWorld,
  openDatabase,
  persistWorld,
  seedWorld,
} from './db.js';
import { buildView } from './views.js';
import {
  completeTask,
  createWorld,
  redeemItem,
  rollover as settleForward,
  spendSkip,
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
  return { db, world };
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

export function redeemItemAction(db, cfg, nowMs, itemName) {
  return withRollover(db, cfg, nowMs, (world) => redeemItem(world, itemName, nowMs, cfg));
}

/**
 * Settle, then hand back the view model every screen renders from.
 *
 * This is the only entry point the ui/ modules use to read: they never touch
 * db.js directly and never derive anything themselves.
 */
export async function loadView(db, cfg, nowMs) {
  const { world } = await runRollover(db, cfg, nowMs);
  return { world, view: buildView(world, nowMs, cfg) };
}

/** The view for a world already in hand — used after an action settles. */
export function viewOf(world, cfg, nowMs) {
  return buildView(world, nowMs, cfg);
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
