/** Shared fixtures for the engine tests. Test-only I/O lives here, not in js/. */

import { readFileSync } from 'node:fs';
import { validateConfig } from '../js/config.js';
import { parseDate, wallToInstant } from '../js/time.js';
import { completeTask, createWorld } from '../js/scoring.js';

export const rawConfig = JSON.parse(
  readFileSync(new URL('../config.json', import.meta.url), 'utf8'),
);

/** A validated config, optionally mutated first. */
export function makeConfig(mutate) {
  const raw = structuredClone(rawConfig);
  if (mutate) mutate(raw);
  return validateConfig(raw);
}

/** A config keeping only the named tasks, to isolate one rule at a time. */
export function onlyTasks(ids, mutate) {
  return makeConfig((raw) => {
    const kept = {};
    for (const id of ids) kept[id] = raw.tasks[id];
    raw.tasks = kept;
    if (mutate) mutate(raw);
  });
}

export const cfg = makeConfig();

/** Instant of a wall-clock time on an app-date, in the configured zone. */
export function at(appDate, hour = 9, minute = 0, config = cfg) {
  return wallToInstant({ ...parseDate(appDate), hour, minute }, config.dayBoundary.timezone);
}

/** Complete a task, asserting it was accepted. */
export function done(world, taskId, appDate, { hour = 9, minute = 0, config = cfg, ...rest } = {}) {
  const res = completeTask(
    world,
    { taskId, timestamp: at(appDate, hour, minute, config), ...rest },
    config,
  );
  if (!res.ok) throw new Error(`completion of ${taskId} on ${appDate} rejected: ${res.reason}`);
  return res.world;
}

export function freshWorld(appDate, config = cfg, hour = 8) {
  return createWorld(at(appDate, hour, 0, config), config);
}

export const openIds = (world) =>
  world.failures.filter((f) => f.resolvedAt === null).map((f) => f.id);

export const snapshot = (world) => JSON.stringify(world);
