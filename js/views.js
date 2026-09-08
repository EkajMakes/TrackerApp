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
  pendingSummary,
  shopState,
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
  const tier = tierFor(world.state.currentStreak, cfg);
  const next = cfg.streak.tiers.find((t) => t.at > world.state.currentStreak) ?? null;
  return {
    balance: world.state.balance,
    negative: world.state.balance < 0,
    atFloor: world.state.balance <= cfg.balanceFloor,
    floor: cfg.balanceFloor,
    streak: world.state.currentStreak,
    // The tier CURRENTLY being applied — never the one being worked toward.
    tierName: tier.name,
    multiplier: tier.multiplier,
    nextTier: next && { name: next.name, multiplier: next.multiplier, daysAway: next.at - world.state.currentStreak },
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
 * Shop                                                                *
 * ------------------------------------------------------------------ */

export function shopView(world, nowMs, cfg) {
  return {
    balance: world.state.balance,
    negative: world.state.balance < 0,
    items: shopState(world, nowMs, cfg).map((item) => ({
      ...item,
      cooldownLabel: item.onCooldown ? humanDuration(item.cooldownRemainingMs) : null,
    })),
    pending: pendingSummary(world, nowMs, cfg),
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
  for (const r of world.redemptions) events.push({ t: r.timestamp, delta: -r.cost });

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

export function historyView(world, nowMs, cfg) {
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

  const redemptions = world.redemptions
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((r) => ({ ...r, label: r.itemName }));

  const resolvedFailures = world.failures
    .filter((f) => f.resolvedAt !== null)
    .sort((a, b) => b.resolvedAt - a.resolvedAt)
    .map((f) => ({ ...f, dateLabel: shortDate(f.incurredAppDate) }));

  return { weeks, weight, balance, redemptions, resolvedFailures };
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

  const anchors = tasks.filter((t) => t.anchor).map((t) => t.label);

  return {
    tasks,
    anchors,
    tiers: cfg.streak.tiers.map((t) => ({ ...t })),
    rules: {
      bonusRequiresAnchor: cfg.bonusRequiresAnchor,
      bonusWeeklyCap: cfg.bonusWeeklyCap,
      skipsPerWeek: cfg.skipsPerWeek,
      skipsRollOver: cfg.skipsRollOver === true,
      undosPerDay: cfg.undosPerDay ?? 0,
      balanceFloor: cfg.balanceFloor,
      boundaryHour: cfg.dayBoundary.hour,
      timezone: cfg.dayBoundary.timezone,
      weekStart: cfg.weekStart,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The whole screen, in one object                                     *
 * ------------------------------------------------------------------ */

export function buildView(world, nowMs, cfg) {
  return {
    now: nowMs,
    header: headerView(world, nowMs, cfg),
    today: todayView(world, nowMs, cfg),
    shop: shopView(world, nowMs, cfg),
    failures: failureView(world, nowMs, cfg),
    info: infoView(cfg),
    history: historyView(world, nowMs, cfg),
  };
}
