/**
 * weekSimulator.js — retune the economy without waiting a real week.
 *
 * Takes a hypothetical set of completions, runs them through the SAME pure
 * engine the app uses, settles the week, and prints the net points. No DOM, no
 * IndexedDB: it builds a world in memory and calls scoring.js directly, so what
 * it prints is what the app would actually do.
 *
 *   node js/devtools/weekSimulator.js                  # the built-in example
 *   node js/devtools/weekSimulator.js scenario.json    # your own
 *   node js/devtools/weekSimulator.js --week 2026-09-07 scenario.json
 *
 * A scenario is a map of weekday → task ids, with an optional repeat count and
 * an optional value for weight/tracker entries:
 *
 *   {
 *     "mon": ["jobs", "pray", "gym", { "task": "chore", "times": 3 }],
 *     "tue": ["jobs", { "task": "weight", "value": 183.2 }]
 *   }
 *
 * It can also be imported: `simulateWeek(scenario, cfg, { weekStart })`.
 */

import { validateConfig } from '../config.js';
import {
  addDays,
  dayCloseInstant,
  wallToInstant,
  parseDate,
  weekdayOf,
} from '../time.js';
import {
  completeTask,
  createWorld,
  rollover,
  tierFor,
} from '../scoring.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** The example scenario: a solid but imperfect week. */
export const EXAMPLE = {
  mon: ['jobs', 'pray', 'weight', 'class', 'gym', 'study', 'stream'],
  tue: ['jobs', 'pray', 'weight', 'gym', 'study', 'content', 'stream'],
  wed: ['jobs', 'pray', 'weight', 'class', 'study', 'content'],
  thu: ['jobs', 'pray', 'weight', 'class', 'gym', 'study', 'stream'],
  fri: ['jobs', 'pray', 'weight', 'class', 'gym', 'content'],
  sat: ['jobs', 'pray', 'weight', 'gym', 'stream', 'house', { task: 'chore', times: 2 }],
  sun: ['jobs', 'pray', 'weight', 'study', 'content', 'volleyball', 'read'],
};

const normalise = (entry) =>
  typeof entry === 'string' ? { task: entry, times: 1 } : { times: 1, ...entry };

/**
 * Run a scenario through the engine. Pure: the caller supplies the config and
 * the week to simulate, and nothing here reads a clock or a database.
 */
export function simulateWeek(scenario, cfg, { weekStart = '2026-09-07' } = {}) {
  if (weekdayOf(weekStart) !== cfg.weekStart.slice(0, 3).toLowerCase()) {
    throw new Error(`weekStart ${weekStart} is a ${weekdayOf(weekStart)}, not a ${cfg.weekStart}`);
  }

  const opened = wallToInstant({ ...parseDate(weekStart), hour: cfg.dayBoundary.hour }, cfg.dayBoundary.timezone);
  let world = createWorld(opened, cfg);
  const startingBalance = world.state.balance;
  const rejected = [];

  for (const [i, weekday] of WEEKDAYS.entries()) {
    const appDate = addDays(weekStart, i);
    let hour = 8;
    for (const entry of (scenario[weekday] ?? []).map(normalise)) {
      for (let n = 0; n < entry.times; n += 1) {
        const timestamp = wallToInstant(
          { ...parseDate(appDate), hour: Math.min(hour, 23), minute: (n * 7) % 60 },
          cfg.dayBoundary.timezone,
        );
        const res = completeTask(
          world,
          { taskId: entry.task, timestamp, value: entry.value ?? null, poolLabel: entry.label ?? null },
          cfg,
        );
        if (!res.ok) rejected.push(`${weekday} ${entry.task}: ${res.reason}`);
        else world = res.world;
        hour += 1;
      }
    }
    // Close the day, which settles that day's bonuses and daily misses.
    world = rollover(world, dayCloseInstant(appDate, cfg), cfg);
  }

  // A moment past the Monday boundary, so the week has closed.
  world = rollover(world, dayCloseInstant(addDays(weekStart, 6), cfg) + 60000, cfg);

  const weekKey = weekStart;
  const inWeek = (rows, key = 'weekKey') => rows.filter((r) => r[key] === weekKey);

  const completions = inWeek(world.completions);
  const byType = (type) => completions.filter((c) => c.taskType === type);
  const sum = (rows) => rows.reduce((total, r) => total + (r.pointsAwarded ?? 0), 0);

  const failures = inWeek(world.failures, 'incurredWeekKey');
  const penalised = failures.reduce((total, f) => total + f.actualDeduction, 0);

  return {
    weekKey,
    weekEnd: addDays(weekStart, 7),
    rejected,
    world,
    earned: sum(completions),
    byType: Object.fromEntries(
      ['quota', 'daily', 'target', 'bonus', 'tracker', 'target-bonus']
        .map((t) => [t, sum(byType(t))])
        .filter(([, points]) => points > 0),
    ),
    bonusAwarded: sum(byType('bonus')),
    bonusCap: cfg.bonusWeeklyCap,
    targetBonuses: byType('target-bonus').map((c) => ({ label: c.label, points: c.pointsAwarded })),
    missedTargets: world.missedTargets.filter((m) => m.weekKey === weekKey),
    failures,
    penalised,
    net: world.state.balance - startingBalance,
    startingBalance,
    endingBalance: world.state.balance,
    streak: world.state.currentStreak,
    tier: tierFor(world.state.currentStreak, cfg),
  };
}

/** Human-readable report. Kept separate so the numbers stay testable. */
export function formatReport(result) {
  const pad = (label) => `  ${label.padEnd(14)}`;
  const lines = [];
  const failureCounts = new Map();
  for (const f of result.failures) {
    failureCounts.set(f.taskId, (failureCounts.get(f.taskId) ?? 0) + 1);
  }

  lines.push(`Week ${result.weekKey} → ${result.weekEnd}`);
  lines.push(`${pad('earned')}+${result.earned}   (${
    Object.entries(result.byType).map(([t, p]) => `${t} ${p}`).join(', ') || 'nothing'
  })`);
  lines.push(`${pad('penalties')}-${result.penalised}${
    failureCounts.size
      ? `   (${[...failureCounts].map(([id, n]) => `${id} x${n}`).join(', ')})`
      : ''
  }`);
  lines.push(`${pad('bonus')}+${result.bonusAwarded}   (cap ${result.bonusCap}, headroom left ${
    Math.max(0, result.bonusCap - result.bonusAwarded)
  })`);
  if (result.targetBonuses.length) {
    lines.push(`${pad('target bonus')}${result.targetBonuses.map((t) => `${t.label} +${t.points}`).join(', ')}`);
  }
  if (result.missedTargets.length) {
    lines.push(`${pad('missed')}${result.missedTargets.map((m) => `${m.label} ${m.reached}/${m.target} (forfeited ${m.forfeited})`).join(', ')}`);
  }
  lines.push(`${pad('multiplier')}ended ${result.tier.name ?? 'no tier'} ${result.tier.multiplier}x on a ${result.streak}-day streak`);
  lines.push(`${pad('NET')}${result.net >= 0 ? '+' : ''}${result.net}   balance ${result.startingBalance} → ${result.endingBalance}`);
  if (result.rejected.length) {
    lines.push(`${pad('rejected')}${result.rejected.join(', ')}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI                                                                 *
 * ------------------------------------------------------------------ */

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('js/devtools/weekSimulator.js');

if (isMain) {
  const { readFileSync } = await import('node:fs');
  const args = process.argv.slice(2);

  let weekStart = '2026-09-07';
  const weekFlag = args.indexOf('--week');
  if (weekFlag !== -1) weekStart = args.splice(weekFlag, 2)[1];

  const cfg = validateConfig(JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8')));
  const scenario = args[0] ? JSON.parse(readFileSync(args[0], 'utf8')) : EXAMPLE;

  const result = simulateWeek(scenario, cfg, { weekStart });
  console.log(`\n${args[0] ?? 'built-in example scenario'}\n`);
  console.log(formatReport(result));
  console.log('');
}
