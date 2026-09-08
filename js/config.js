/**
 * config.js — load, validate and freeze config.json.
 *
 * Validation and normalisation are PURE: they take the parsed object and
 * return a frozen config or throw. loadConfig() takes an injected fetch, so
 * this module performs no ambient I/O and stays testable under node --test.
 *
 * Every tunable value lives in config.json and is never duplicated in code
 * (CLAUDE.md rule 8). A broken economy must not boot (rule 9).
 */

import { WEEKDAYS } from './time.js';

export const TASK_TYPES = ['quota', 'daily', 'target', 'bonus', 'tracker'];
export const PENALTY_TYPES = ['quota', 'daily'];

export class ConfigError extends Error {
  constructor(problems) {
    super(
      'config.json is invalid — refusing to boot a broken economy:\n  - ' + problems.join('\n  - '),
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function isNonNegativeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Validate and normalise. Collects every problem before throwing, so one run
 * reports the whole list rather than only the first offender.
 */
export function validateConfig(raw) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  if (!raw || typeof raw !== 'object') throw new ConfigError(['config is not an object']);

  // --- global values -------------------------------------------------------
  const db = raw.dayBoundary;
  if (!db || !Number.isInteger(db.hour) || db.hour < 0 || db.hour > 23) {
    fail('dayBoundary.hour must be an integer 0-23');
  }
  if (!db || typeof db.timezone !== 'string' || !db.timezone.includes('/')) {
    fail('dayBoundary.timezone must be an IANA identifier such as "America/Chicago"');
  } else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: db.timezone });
    } catch {
      fail('dayBoundary.timezone "' + db.timezone + '" is not a timezone this runtime knows');
    }
  }
  if (WEEKDAYS.indexOf(String(raw.weekStart ?? '').slice(0, 3).toLowerCase()) === -1) {
    fail('weekStart must be a weekday name such as "monday"');
  }
  if (typeof raw.balanceFloor !== 'number' || raw.balanceFloor > 0) {
    fail('balanceFloor must be a number <= 0');
  }
  if (!isNonNegativeNumber(raw.bonusWeeklyCap)) fail('bonusWeeklyCap must be >= 0');
  if (!Number.isInteger(raw.skipsPerWeek) || raw.skipsPerWeek < 0) {
    fail('skipsPerWeek must be an integer >= 0');
  }
  if (typeof raw.bonusRequiresAnchor !== 'boolean') fail('bonusRequiresAnchor must be a boolean');
  if (raw.undosPerDay !== undefined && (!Number.isInteger(raw.undosPerDay) || raw.undosPerDay < 0)) {
    fail('undosPerDay must be an integer >= 0');
  }

  // --- tasks ---------------------------------------------------------------
  const tasks = {};
  if (!raw.tasks || typeof raw.tasks !== 'object') {
    fail('tasks must be an object');
  } else {
    for (const [id, t] of Object.entries(raw.tasks)) {
      const where = 'task "' + id + '"';
      if (!t || typeof t !== 'object') {
        fail(where + ' is not an object');
        continue;
      }
      if (!TASK_TYPES.includes(t.type)) {
        fail(where + ' has unknown type "' + t.type + '" (expected ' + TASK_TYPES.join(' | ') + ')');
        continue;
      }
      if (typeof t.label !== 'string' || !t.label) fail(where + ' needs a label');
      if (!isNonNegativeNumber(t.points)) fail(where + ' needs numeric points >= 0');

      // Rule 9: penalty must equal points for every quota and daily task.
      if (PENALTY_TYPES.includes(t.type)) {
        if (!isNonNegativeNumber(t.penalty)) {
          fail(where + ' is a ' + t.type + ' task and needs a numeric penalty');
        } else if (t.penalty !== t.points) {
          fail(
            where + ' has penalty ' + t.penalty + ' but points ' + t.points +
            ' — penalty must equal points for every quota and daily task',
          );
        }
      }
      if ((t.type === 'quota' || t.type === 'target') && !isPositiveInt(t.target)) {
        fail(where + ' is a ' + t.type + ' task and needs an integer target > 0');
      }
      if (t.type === 'target' && !isNonNegativeNumber(t.targetBonus)) {
        fail(where + ' is a target task and needs a numeric targetBonus');
      }
      if (t.type === 'bonus' && !isPositiveInt(t.dailyCap)) {
        fail(where + ' is a bonus task and needs an integer dailyCap > 0');
      }
      if (t.type === 'daily' && t.dailyTarget !== undefined && !isPositiveInt(t.dailyTarget)) {
        fail(where + ' has dailyTarget ' + t.dailyTarget + '; it must be a positive integer');
      }
      if (t.pool !== undefined && (!Array.isArray(t.pool) || t.pool.length === 0)) {
        fail(where + ' has a pool that is not a non-empty array');
      }

      // rosters and per-weekday flags
      if (t.days !== 'all') {
        if (!Array.isArray(t.days) || t.days.length === 0) {
          fail(where + ' days must be "all" or a non-empty weekday array');
        } else {
          for (const d of t.days) {
            if (!WEEKDAYS.includes(d)) fail(where + ' has unknown weekday "' + d + '" in days');
          }
        }
      }
      if (t.dayFlags !== undefined) {
        if (typeof t.dayFlags !== 'object' || t.dayFlags === null) {
          fail(where + ' dayFlags must be an object keyed by weekday');
        } else {
          for (const d of Object.keys(t.dayFlags)) {
            if (!WEEKDAYS.includes(d)) fail(where + ' has unknown weekday "' + d + '" in dayFlags');
          }
        }
      }

      tasks[id] = {
        ...t,
        id,
        anchor: t.anchor === true,
        // dailyTarget defaults to 1 when absent on a daily task.
        ...(t.type === 'daily' ? { dailyTarget: t.dailyTarget ?? 1 } : {}),
      };
    }
  }

  // --- streak tiers --------------------------------------------------------
  const tiers = raw.streak?.tiers;
  if (!Array.isArray(tiers)) {
    fail('streak.tiers must be an array');
  } else {
    let prev = -Infinity;
    for (const tier of tiers) {
      if (!isPositiveInt(tier?.at)) fail('streak tier "' + tier?.name + '" needs an integer at > 0');
      if (!(typeof tier?.multiplier === 'number' && tier.multiplier >= 1)) {
        fail('streak tier "' + tier?.name + '" needs a multiplier >= 1');
      }
      if (tier?.at <= prev) fail('streak.tiers must be sorted ascending by "at"');
      prev = tier?.at;
    }
  }

  // --- shop ----------------------------------------------------------------
  const seen = new Set();
  if (!Array.isArray(raw.shop)) {
    fail('shop must be an array');
  } else {
    for (const item of raw.shop) {
      if (typeof item?.name !== 'string' || !item.name) {
        fail('every shop item needs a name');
        continue;
      }
      if (seen.has(item.name)) fail('shop item name "' + item.name + '" is duplicated');
      seen.add(item.name);
      if (!isNonNegativeNumber(item.cost)) fail('shop item "' + item.name + '" needs a numeric cost');
      if (item.cooldownDays !== undefined && !isNonNegativeNumber(item.cooldownDays)) {
        fail('shop item "' + item.name + '" has a non-numeric cooldownDays');
      }
    }
  }

  if (problems.length) throw new ConfigError(problems);

  return deepFreeze({ ...raw, tasks });
}

/**
 * Fetch and validate config.json. `fetchImpl` is injected so this module never
 * reaches for an ambient global; the service worker is network-first for this
 * URL so a reload while online always picks up a retune.
 */
export async function loadConfig(fetchImpl, url = './config.json') {
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('could not load ' + url + ': HTTP ' + res.status);
  return validateConfig(await res.json());
}

/* ------------------------------------------------------------------ *
 * Small readers, so no caller has to poke at raw config shapes        *
 * ------------------------------------------------------------------ */

export function taskList(cfg) {
  return Object.values(cfg.tasks);
}

export function tasksOfType(cfg, type) {
  return taskList(cfg).filter((t) => t.type === type);
}

export function isRostered(task, weekday) {
  return task.days === 'all' || task.days.includes(weekday);
}

export function dailyTargetOf(task) {
  return task.dailyTarget ?? 1;
}

export function dayFlagOf(task, weekday) {
  return task.dayFlags?.[weekday] ?? null;
}
