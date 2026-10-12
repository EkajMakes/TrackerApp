/**
 * db.js — IndexedDB persistence. Storage only: no scoring logic lives here.
 *
 * The engine works on a plain "world" object (see scoring.js). This module
 * loads that shape out of IndexedDB and writes it back, and knows nothing
 * about points, penalties, tiers or boundaries.
 *
 * Two rules it exists to uphold:
 *  - NOTHING IS EVER DELETED. There is no delete() call in this file and no
 *    clearing of a store. End-of-life is a field on a retained row.
 *  - The export dumps every store in full, straight from the database rather
 *    than from any in-memory view.
 */

export const DB_NAME = 'habitTracker';
export const DB_VERSION = 2;
export const STATE_KEY = 'app';
export const META_KEY = 'meta';

/** The stores, with the indexes each one needs. */
export const STORES = {
  completions: {
    keyPath: 'id',
    indexes: {
      by_taskId_weekKey: ['taskId', 'weekKey'],
      by_appDate: 'appDate',
      by_weekKey: 'weekKey',
    },
  },
  failures: {
    keyPath: 'id',
    indexes: {
      by_redeemThroughWeekKey: 'redeemThroughWeekKey',
      by_incurredWeekKey: 'incurredWeekKey',
      by_taskId: 'taskId',
    },
  },
  skips: { keyPath: 'id', indexes: { by_grantedWeekKey: 'grantedWeekKey' } },
  missedTargets: { keyPath: 'id', indexes: { by_weekKey: 'weekKey' } },
  // Rows rescued from features that have been cut. Cutting a feature is not
  // permission to lose its history, so the v1 `redemptions` store was copied
  // here before it was dropped (see migrateToV2).
  archive: { keyPath: 'id', indexes: { by_store: 'store' } },
  // Survives the reset wipe, which is the entire point of it: a reset counter
  // erased by its own reset would be infinitely reusable.
  meta: { keyPath: 'id', indexes: {} },
  state: { keyPath: 'id', indexes: {} },
};

/** Stores removed in a later version, kept here so upgrades stay readable. */
export const RETIRED_STORES = ['redemptions'];

/** Collections that make up a world, in the order the export lists them. */
export const COLLECTIONS = [
  'completions',
  'failures',
  'skips',
  'missedTargets',
  'archive',
];

/* ------------------------------------------------------------------ *
 * Promise wrappers over the IndexedDB event API                       *
 * ------------------------------------------------------------------ */

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/**
 * Open (and if needed create) the database.
 *
 * `factory` is injected — the browser passes globalThis.indexedDB, the tests
 * pass fake-indexeddb — so this module never reaches for an ambient global.
 */
export function openDatabase(factory, name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      for (const [storeName, def] of Object.entries(STORES)) {
        const store = db.objectStoreNames.contains(storeName)
          ? request.transaction.objectStore(storeName)
          : db.createObjectStore(storeName, { keyPath: def.keyPath });
        for (const [indexName, keyPath] of Object.entries(def.indexes)) {
          if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath);
        }
      }
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        migrateToV2(db, request.transaction);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database upgrade blocked by another tab'));
  });
}

/**
 * v1 → v2: the shop was cut, so the `redemptions` store goes.
 *
 * Every row is copied into `archive` FIRST, inside the same version-change
 * transaction, and only then is the store dropped. Losing a feature must not
 * lose its history — the export has always promised every redemption ever
 * made, and that promise outlives the feature that created them.
 */
function migrateToV2(db, tx) {
  if (!db.objectStoreNames.contains('redemptions')) return;

  const source = tx.objectStore('redemptions');
  const archive = tx.objectStore('archive');
  const request = source.getAll();
  request.onsuccess = () => {
    for (const row of request.result ?? []) {
      archive.put({
        id: `archive:redemptions:${row.id}`,
        store: 'redemptions',
        archivedAt: Date.now(),
        archivedBecause: 'the shop was removed in stage 6; points became a score',
        row,
      });
    }
    // Dropped only once the rows are safely copied.
    db.deleteObjectStore('redemptions');
  };
}


/* ------------------------------------------------------------------ *
 * Reading                                                             *
 * ------------------------------------------------------------------ */

/**
 * Load the whole world in one readonly transaction.
 * Returns null when the database has never been seeded.
 */
export async function loadWorld(db) {
  const names = [...COLLECTIONS, 'state'];
  const tx = db.transaction(names, 'readonly');
  const results = await Promise.all([
    ...COLLECTIONS.map((n) => requestToPromise(tx.objectStore(n).getAll())),
    requestToPromise(tx.objectStore('state').get(STATE_KEY)),
  ]);
  await transactionDone(tx);

  const state = results[results.length - 1];
  if (!state) return null;

  const world = {};
  COLLECTIONS.forEach((name, i) => {
    world[name] = results[i];
  });
  const { id, ...rest } = state;
  world.state = rest;
  return world;
}

/**
 * The meta row — app-lifetime facts that must outlive a wipe.
 *
 * Deliberately NOT part of the world: the world is what a reset erases, and
 * `resetsUsed` living there would mean the reset erases its own counter and
 * can be used forever.
 */
export async function readMeta(db) {
  const tx = db.transaction('meta', 'readonly');
  const row = await requestToPromise(tx.objectStore('meta').get(META_KEY));
  await transactionDone(tx);
  return { resetsUsed: 0, ...(row ?? {}) };
}

export async function writeMeta(db, patch) {
  const current = await readMeta(db);
  const next = { ...current, ...patch, id: META_KEY };
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(next);
  await transactionDone(tx);
  const { id, ...rest } = next;
  return rest;
}

/** Read one collection through an index — used by the History views. */
export async function queryIndex(db, storeName, indexName, query) {
  const tx = db.transaction(storeName, 'readonly');
  const rows = await requestToPromise(tx.objectStore(storeName).index(indexName).getAll(query));
  await transactionDone(tx);
  return rows;
}

/* ------------------------------------------------------------------ *
 * Writing                                                             *
 * ------------------------------------------------------------------ */

const sameRow = (a, b) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * Persist the difference between two worlds in ONE readwrite transaction
 * spanning every store, so a crash mid-walk rolls back whole: a partially
 * settled week is never persisted.
 *
 * Only new or changed rows are written, and rows are only ever put — a row
 * that disappeared from `after` would be left alone rather than deleted,
 * because collections are append-only by construction.
 */
export async function persistWorld(db, before, after) {
  const names = [...COLLECTIONS, 'state'];
  const tx = db.transaction(names, 'readwrite');
  let written = 0;

  for (const name of COLLECTIONS) {
    const previous = new Map((before?.[name] ?? []).map((row) => [row.id, row]));
    const store = tx.objectStore(name);
    for (const row of after[name] ?? []) {
      if (sameRow(previous.get(row.id), row)) continue;
      store.put(row);
      written += 1;
    }
  }

  if (!sameRow(before?.state, after.state)) {
    tx.objectStore('state').put({ id: STATE_KEY, ...after.state });
    written += 1;
  }

  await transactionDone(tx);
  return written;
}

/** Seed a brand-new database with a world built by the engine. */
export async function seedWorld(db, world) {
  await persistWorld(db, null, world);
  return world;
}

/* ------------------------------------------------------------------ *
 * Export                                                              *
 * ------------------------------------------------------------------ */

/**
 * Dump every store in full, read straight from the database.
 *
 * Day-one feature: every completion, failure (open, redeemed and expired),
 * skip (available, spent and lapsed), missed target and weight entry ever
 * recorded, plus `archive` (rows rescued from cut features, including every
 * shop redemption ever made), `meta`, the state row, and the config in use.
 */
export async function exportDatabase(db, cfg = null, exportedAt = null) {
  const names = [...COLLECTIONS, 'meta', 'state'];
  const tx = db.transaction(names, 'readonly');
  const rows = await Promise.all(names.map((n) => requestToPromise(tx.objectStore(n).getAll())));
  await transactionDone(tx);

  const dump = {
    exportedFrom: 'TrackerApp',
    exportedAt,
    schemaVersion: DB_VERSION,
    configSnapshot: cfg,
  };
  names.forEach((name, i) => {
    dump[name] = rows[i];
  });
  return dump;
}

/* ------------------------------------------------------------------ *
 * Import                                                              *
 * ------------------------------------------------------------------ */

export class ImportRefused extends Error {
  constructor(code, message, summary) {
    super(message);
    this.name = 'ImportRefused';
    this.code = code;
    this.summary = summary;
  }
}

/** Newest instant across every timestamped field a record can carry. */
function newestInstant(source) {
  let newest = null;
  const consider = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && (newest === null || v > newest)) newest = v;
  };
  for (const c of source.completions ?? []) { consider(c.timestamp); consider(c.settledAt); }
  // v1 dumps still carry a redemptions array; its timestamps still count.
  for (const r of source.redemptions ?? []) consider(r.timestamp);
  for (const f of source.failures ?? []) { consider(f.createdAt); consider(f.resolvedAt); }
  for (const r of source.redemptions ?? []) consider(r.timestamp);
  for (const s of source.skips ?? []) { consider(s.grantedAt); consider(s.spentAt); consider(s.lapsedAt); }
  for (const m of source.missedTargets ?? []) consider(m.at);
  return newest;
}

/** What a world holds, in the terms the refusal messages speak in. */
function summarise(source) {
  const completions = source.completions ?? [];
  // appDate is stored on every completion, so the human-facing "through" date
  // needs no date arithmetic here.
  const through = completions.reduce(
    (latest, c) => (c.appDate && (!latest || c.appDate > latest) ? c.appDate : latest),
    null,
  );
  return {
    completions: completions.length,
    through,
    newestInstant: newestInstant(source),
  };
}

const describe = (s) =>
  `${s.completions} completion${s.completions === 1 ? '' : 's'}${s.through ? ` through ${s.through}` : ''}`;

/**
 * Compare a dump against the database it would be restored into, and report
 * everything that should stop the import. Read-only: it writes nothing.
 *
 * Returns { ok, blocking, needsConfirmation, target, file } where `blocking`
 * can never be waived and `needsConfirmation` lists the codes a caller must
 * explicitly pass to proceed.
 */
export async function inspectImport(db, dump) {
  const world = await loadWorld(db);
  const target = summarise(world ?? {});
  const file = summarise(dump ?? {});
  const blocking = [];
  const needsConfirmation = [];

  if (dump?.schemaVersion !== DB_VERSION) {
    blocking.push({
      code: 'schema-mismatch',
      message:
        `This backup was written by schema version ${dump?.schemaVersion ?? 'unknown'}, ` +
        `but this app uses version ${DB_VERSION}. Importing it could scramble your history, ` +
        `so it is refused. Use a build that matches the file, or re-export from this one.`,
    });
  }

  if (target.completions > 0) {
    needsConfirmation.push({
      code: 'target-not-empty',
      confirm: 'confirmOverwrite',
      message:
        `This database has ${describe(target)}; the file has ${describe(file)}. ` +
        `Importing merges the file into what is already here and cannot be undone. ` +
        `Confirm that you mean to do this.`,
    });
  }

  if (
    target.newestInstant !== null &&
    file.newestInstant !== null &&
    file.newestInstant < target.newestInstant
  ) {
    needsConfirmation.push({
      code: 'stale-file',
      confirm: 'confirmStale',
      message:
        `The file is older than this database: its newest record is ${describe(file)}, ` +
        `while this database already holds ${describe(target)}. ` +
        `Restoring a stale backup over newer data is almost always a mistake. ` +
        `Confirm separately that this is what you want.`,
    });
  }

  return {
    ok: blocking.length === 0 && needsConfirmation.length === 0,
    blocking,
    needsConfirmation,
    target,
    file,
  };
}

/**
 * Restore a dump produced by exportDatabase.
 *
 * Guarded, because this is the one operation that can bury real history:
 *  - a schema mismatch is refused outright;
 *  - restoring into a database that already holds completions needs
 *    `confirmOverwrite`, and the refusal names both worlds so the choice is
 *    made with the numbers in view;
 *  - a file older than the database needs `confirmStale` on top of that.
 *    Stale-over-fresh is the mistake worth being loud about.
 *
 * It still clears nothing: rows are put by their own ids, so a restore merges,
 * and there is no delete path anywhere in this module. Wiping first, when that
 * is genuinely wanted, is `indexedDB.deleteDatabase` at the call site.
 */
export async function importDatabase(db, dump, { confirmOverwrite = false, confirmStale = false } = {}) {
  const report = await inspectImport(db, dump);
  const confirmed = { confirmOverwrite, confirmStale };

  const [blocked] = report.blocking;
  if (blocked) throw new ImportRefused(blocked.code, blocked.message, report);

  const unconfirmed = report.needsConfirmation.find((r) => !confirmed[r.confirm]);
  if (unconfirmed) throw new ImportRefused(unconfirmed.code, unconfirmed.message, report);

  return writeImport(db, dump);
}

async function writeImport(db, dump) {
  const names = [...COLLECTIONS, 'meta', 'state'];
  const tx = db.transaction(names, 'readwrite');
  let restored = 0;
  for (const name of names) {
    const rows = dump[name];
    if (!Array.isArray(rows)) continue;
    const store = tx.objectStore(name);
    for (const row of rows) {
      store.put(row);
      restored += 1;
    }
  }
  await transactionDone(tx);
  return restored;
}
