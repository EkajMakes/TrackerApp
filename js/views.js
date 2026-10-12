/**
 * views.js — PURE presentation derivations. No DOM, no IndexedDB, no clock.
 *
 * The rule for stage 3 is that a ui/ module computes nothing: it turns a view
 * model into elements and wires taps to actions. Everything a screen needs to
 * *know* is derived here, on top of the engine, so no aggregation, rounding,
 * date arithmetic or config lookup ever leaks into a renderer.
 *
 * Nothing in this file decides economy rules — it reads them from scoring.js
 * and config.js and arranges the answers for display.
 */

import { appDateOf, weekKeyOf, weekdayOf, parseDate, weekKeyBefore } from './time.js';
import { scheduleView as buildScheduleView } from './schedule.js';
import { dailyTargetOf, dayFlagOf, isRostered, taskList } from './config.js';
import {
  anchoredOn,
  availableSkips,
  award,
  bonusHeadroom,
  completionsOfTaskInWeek,
  completionsOfTaskOnDay,
  groupedFailures,
  isLive,
  nextTierFor,
  pendingSummary,
  records,
  tierFor,
  undoBlockedReason,
  undosRemaining,
} from './scoring.js';
import { dailyTargetOf as dailyTargetFor } from './config.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_LABEL = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

/** "2026-09-07" → "Sep 7". Label formatting only; the math lives in time.js. */
export function shortDate(appDate) {
  const { month, day } = parseDate(appDate);
  return `${MONTHS[month - 1]} ${day}`;
}

/** A duration in ms → "2d 4h" / "6h 12m" / "8m". */
export function humanDuration(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/* ------------------------------------------------------------------ *
 * Header — pinned to every screen                                     *
 * ------------------------------------------------------------------ */

export function headerView(world, nowMs, cfg) {
  const pending = pendingSummary(world, nowMs, cfg);
  const streak = world.state.currentStreak;
  const tier = tierFor(streak, cfg);
  const next = nextTierFor(streak, cfg);
  const best = records(world, cfg);

  // What the ladder line says. Below the top rung it counts down to the next
  // name; on the open-ended rung it reports the day number and tomorrow's
  // multiplier, because there is no next name to reach.
  let progress;
  if (next) {
    const daysAway = next.at - streak;
    progress = {
      kind: 'next-tier',
      daysAway,
      nextName: next.name,
      text: `${daysAway} more day${daysAway === 1 ? '' : 's'} to ${next.name}`,
    };
  } else if (tier.beyond && tier.atCap) {
    progress = { kind: 'capped', text: `Day ${tier.daysIntoTier + 1} · ${tier.multiplier.toFixed(2)}x · maxed` };
  } else if (tier.beyond) {
    progress = {
      kind: 'climbing',
      text: `Day ${tier.daysIntoTier + 1} · ${tier.multiplier.toFixed(2)}x · +${tier.perDay.toFixed(2)} tomorrow`,
    };
  } else {
    progress = { kind: 'top', text: `${tier.multiplier.toFixed(2)}x` };
  }

  return {
    // `balance` keeps its name in the data; the UI calls it Points, because
    // nothing is spent any more.
    balance: world.state.balance,
    negative: world.state.balance < 0,
    atFloor: world.state.balance <= cfg.balanceFloor,
    floor: cfg.balanceFloor,
    streak,
    // The tier CURRENTLY being applied — never the one being worked toward.
    tierName: tier.name,
    tierColor: tier.color ?? null,
    tierSlug: String(tier.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    tierIndex: cfg.streak.tiers.findIndex((t) => t.name === tier.name),
    tierCount: cfg.streak.tiers.length,
    multiplier: tier.multiplier,
    beyond: tier.beyond,
    atCap: tier.atCap,
    progress,
    nextTier: next && { name: next.name, multiplier: next.multiplier, daysAway: next.at - streak },
    // Stated plainly, never scolding: the fact and the record it fell short of.
    recordStreak: best.longestStreak.days,
    isRecordNow: best.isRecordNow,
    behindRecordBy: best.behindRecordBy,
    skipsAvailable: availableSkips(world).length,
    pending,
  };
}

/* ------------------------------------------------------------------ *
 * Today                                                               *
 * ------------------------------------------------------------------ */

export function todayView(world, nowMs, cfg) {
  const appDate = appDateOf(nowMs, cfg);
  const weekKey = weekKeyOf(appDate, cfg);
  const weekday = weekdayOf(appDate);
  const tier = tierFor(world.state.currentStreak, cfg);
  const anchored = anchoredOn(world, appDate, cfg);
  const locked = cfg.bonusRequiresAnchor && !anchored;

  const undosLeft = undosRemaining(world, nowMs, cfg);

  const tasks = taskList(cfg)
    .filter((task) => isRostered(task, weekday))
    .map((task) => {
      const todaysCompletions = completionsOfTaskOnDay(world, task.id, appDate);
      const doneToday = todaysCompletions.length;
      const doneThisWeek = completionsOfTaskInWeek(world, task.id, weekKey).length;

      let progress = null;
      if (task.type === 'quota' || task.type === 'target') {
        progress = { done: doneThisWeek, target: task.target, scope: 'week' };
      } else if (task.type === 'daily') {
        progress = { done: doneToday, target: dailyTargetOf(task), scope: 'day' };
      } else if (task.type === 'bonus') {
        progress = { done: doneToday, target: task.dailyCap, scope: 'cap' };
      }

      const met = progress ? progress.done >= progress.target : false;
      const capReached = task.type === 'bonus' && doneToday >= task.dailyCap;
      const overTarget = met && (task.type === 'quota' || task.type === 'daily') && !task.extraEarnsPoints;

      return {
        id: task.id,
        label: task.label,
        type: task.type,
        anchor: task.anchor,
        points: task.points,
        // What this tap is worth right now, at the tier in force today.
        awardNow: task.type === 'bonus' ? award(task.points, tier) : (overTarget ? 0 : award(task.points, tier)),
        targetBonus: task.targetBonus ?? null,
        flag: dayFlagOf(task, weekday),
        progress,
        met,
        overTarget,
        capReached,
        locked: task.type === 'bonus' && locked,
        needsValue: task.unit != null,
        unit: task.unit ?? null,
        pool: task.pool ?? null,
        disabled: capReached,
        // The most recent live completion is the one an undo would take back;
        // the control only appears while that is actually possible.
        undoable: (() => {
          const latest = todaysCompletions.at(-1);
          if (!latest) return null;
          if (undoBlockedReason(world, latest, nowMs, cfg)) return null;
          return { id: latest.id, pointsAwarded: latest.pointsAwarded, label: task.label };
        })(),
      };
    });

  return {
    appDate,
    dateLabel: shortDate(appDate),
    weekdayLabel: WEEKDAY_LABEL[weekday],
    anchored,
    locked,
    tasks,
    pending: pendingSummary(world, nowMs, cfg),
    bonusHeadroom: bonusHeadroom(world, weekKey, cfg),
    bonusWeeklyCap: cfg.bonusWeeklyCap,
    undosRemaining: undosLeft,
    undosPerDay: cfg.undosPerDay ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Failure log                                                         *
 * ------------------------------------------------------------------ */

export function failureView(world, nowMs, cfg) {
  const currentWeek = weekKeyOf(appDateOf(nowMs, cfg), cfg);
  return {
    groups: groupedFailures(world),
    skipsAvailable: availableSkips(world).length,
    // Missed weekly targets are shown apart: not failures, not redeemable.
    missedTargets: world.missedTargets
      .filter((m) => m.weekKey >= weekKeyBefore(currentWeek))
      .map((m) => ({ ...m, weekLabel: shortDate(m.weekKey) })),
  };
}

/* ------------------------------------------------------------------ *
 * History                                                             *
 * ------------------------------------------------------------------ */

/** Every balance-moving event, oldest first, accumulated into a series. */
function balanceSeries(world) {
  const events = [];
  for (const c of world.completions) {
    if (c.pointsAwarded) events.push({ t: c.settledAt ?? c.timestamp, delta: c.pointsAwarded });
    // An undo took its points back out at the moment it was voided.
    if (c.voidedAt && c.voidedRefund) events.push({ t: c.voidedAt, delta: -c.voidedRefund });
  }
  for (const f of world.failures) {
    events.push({ t: f.createdAt, delta: -f.actualDeduction });
    if (f.resolvedVia === 'skip') events.push({ t: f.resolvedAt, delta: f.actualDeduction });
  }

  events.sort((a, b) => a.t - b.t);
  let running = 0;
  return events.map((e) => {
    running += e.delta;
    return { t: e.t, balance: running };
  });
}

function seriesBounds(values) {
  if (!values.length) return { min: 0, max: 0, range: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, range: max - min || 1 };
}

export function historyView(world, nowMs, cfg, meta = null) {
  const currentWeek = weekKeyOf(appDateOf(nowMs, cfg), cfg);

  // --- completions by week -------------------------------------------------
  const byWeek = new Map();
  const weekOf = (key) => {
    if (!byWeek.has(key)) {
      byWeek.set(key, {
        weekKey: key,
        label: shortDate(key),
        isCurrent: key === currentWeek,
        earned: 0,
        penalised: 0,
        refunded: 0,
        tasks: new Map(),
      });
    }
    return byWeek.get(key);
  };

  for (const c of world.completions) {
    if (!isLive(c)) continue; // undone taps are history, not counts
    const week = weekOf(c.weekKey);
    week.earned += c.pointsAwarded ?? 0;
    const row = week.tasks.get(c.taskId)
      ?? { taskId: c.taskId, label: c.label ?? c.taskId, count: 0, points: 0, pending: 0 };
    row.count += 1;
    row.points += c.pointsAwarded ?? 0;
    // An unsettled bonus is not a zero — it has not been scored yet.
    if (c.pointsAwarded === null) row.pending += 1;
    week.tasks.set(c.taskId, row);
  }
  for (const f of world.failures) {
    const week = weekOf(f.incurredWeekKey);
    week.penalised += f.actualDeduction;
    if (f.resolvedVia === 'skip') week.refunded += f.actualDeduction;
  }

  const weeks = [...byWeek.values()]
    .map((w) => ({
      ...w,
      tasks: [...w.tasks.values()].sort((a, b) => b.points - a.points || a.label.localeCompare(b.label)),
      net: w.earned - w.penalised + w.refunded,
    }))
    .sort((a, b) => b.weekKey.localeCompare(a.weekKey));

  // --- weight: the recorded VALUE only, never a scoring signal -------------
  const weightEntries = world.completions
    .filter((c) => isLive(c) && c.value !== null && c.value !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((c) => ({ appDate: c.appDate, label: shortDate(c.appDate), value: c.value, unit: c.unit }));
  const weight = {
    entries: weightEntries,
    unit: weightEntries.at(-1)?.unit ?? null,
    latest: weightEntries.at(-1)?.value ?? null,
    ...seriesBounds(weightEntries.map((e) => e.value)),
  };

  // --- running balance -----------------------------------------------------
  const series = balanceSeries(world);
  const balance = {
    points: series,
    current: world.state.balance, // the state row stays authoritative
    floor: cfg.balanceFloor,
    ...seriesBounds(series.map((p) => p.balance)),
  };

  const resolvedFailures = world.failures
    .filter((f) => f.resolvedAt !== null)
    .sort((a, b) => b.resolvedAt - a.resolvedAt)
    .map((f) => ({ ...f, dateLabel: shortDate(f.incurredAppDate) }));

  // What a wipe would destroy, in the terms the confirmation speaks in.
  const liveOnly = world.completions.filter(isLive);
  const resetsUsed = meta?.resetsUsed ?? 0;
  const reset = {
    resetsUsed,
    resetsAllowed: cfg.resetsAllowed ?? 0,
    resetsRemaining: Math.max(0, (cfg.resetsAllowed ?? 0) - resetsUsed),
    lastResetLabel: meta?.lastResetAt ? shortDate(appDateOf(meta.lastResetAt, cfg)) : null,
    completions: world.completions.length,
    live: liveOnly.length,
    failures: world.failures.length,
    archived: (world.archive ?? []).length,
    balance: world.state.balance,
    streak: world.state.currentStreak,
    since: liveOnly.reduce((first, c) => (!first || c.appDate < first ? c.appDate : first), null),
    through: liveOnly.reduce((last, c) => (!last || c.appDate > last ? c.appDate : last), null),
  };

  return { weeks, weight, balance, resolvedFailures, reset, records: recordsView(world, cfg) };
}

/**
 * Records — the ratchet that replaced spending.
 *
 * Every figure is derived from the ledger on read; nothing is stored, so a
 * voided completion or a restored backup can never leave a record stranded
 * above what actually happened.
 */
export function recordsView(world, cfg) {
  const r = records(world, cfg);
  return {
    longestStreak: {
      ...r.longestStreak,
      startLabel: r.longestStreak.start ? shortDate(r.longestStreak.start) : null,
      endLabel: r.longestStreak.end ? shortDate(r.longestStreak.end) : null,
    },
    longestTopTierRun: r.longestTopTierRun,
    bestWeek: r.bestWeek && { ...r.bestWeek, label: shortDate(r.bestWeek.weekKey) },
    current: r.current,
    behindRecordBy: r.behindRecordBy,
    isRecordNow: r.isRecordNow,
  };
}

/* ------------------------------------------------------------------ *
 * Info — a reference tab, read wholly from config                     *
 * ------------------------------------------------------------------ */

const TYPE_BLURB = {
  quota: 'weekly target, penalised per unit short',
  daily: 'due every day, penalised if missed',
  target: 'weekly target, bonus if met, never penalised',
  bonus: 'extra points, capped daily and weekly, never penalised',
  tracker: 'records a value, never penalised',
};

/**
 * The task table and the rules explainer. Every number here comes from
 * config.json, so a retune is reflected without touching a line of code.
 */
export function infoView(cfg) {
  const tasks = taskList(cfg).map((task) => ({
    id: task.id,
    label: task.label,
    type: task.type,
    typeBlurb: TYPE_BLURB[task.type] ?? task.type,
    points: task.points,
    penalty: task.penalty ?? null,
    target:
      task.type === 'quota' || task.type === 'target'
        ? { value: task.target, scope: 'week' }
        : task.type === 'daily'
          ? { value: dailyTargetFor(task), scope: 'day' }
          : task.type === 'bonus'
            ? { value: task.dailyCap, scope: 'cap' }
            : null,
    targetBonus: task.targetBonus ?? null,
    anchor: task.anchor === true,
    days: task.days === 'all' ? 'every day' : task.days.join(' · '),
    extraEarnsPoints: task.extraEarnsPoints === true,
  }));

  // The points explainer is gone: Info is the schedule, the gallery and the
  // task reference, nothing more.
  return { tasks };
}

/* ------------------------------------------------------------------ *
 * The whole screen, in one object                                     *
 * ------------------------------------------------------------------ */

export function buildView(world, nowMs, cfg, extras = {}) {
  return {
    now: nowMs,
    header: headerView(world, nowMs, cfg),
    today: todayView(world, nowMs, cfg),
    // The schedule is config-shaped data rather than ledger state, so it is
    // passed in rather than derived from the world.
    schedule: extras.schedule
      ? buildScheduleView(extras.schedule, nowMs, cfg, extras.scheduleOffset ?? 0)
      : null,
    failures: failureView(world, nowMs, cfg),
    info: infoView(cfg),
    history: historyView(world, nowMs, cfg, extras.meta ?? null),
  };
}
