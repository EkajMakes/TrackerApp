/**
 * scoring.js — THE ENGINE. Pure: no DOM, no IndexedDB, no Date.now().
 *
 * Everything operates on a plain "world" object and an explicit instant, both
 * passed in as arguments, and returns a new world. rollover.js (stage 2) maps
 * IndexedDB stores onto this shape; the tests drive it directly.
 *
 *   world = {
 *     state:        { lastProcessedTimestamp, lastSettledAppDate, balance,
 *                     currentStreak, currentWeekKey },
 *     completions:  [...],   // append-only event ledger, source of truth
 *     failures:     [...],   // never deleted; resolved with resolvedAt/Via
 *     skips:        [...],   // never deleted; lapsed with lapsedAt
 *     redemptions:  [...],
 *     missedTargets:[...],   // display only — not failures, not redeemable
 *   }
 *
 * Invariants this file must never trade away (see CLAUDE.md):
 *  - records are never removed from a collection, only resolved in place;
 *  - points are scored once at the settling event, never recomputed later;
 *  - the multiplier applies to earned points only, never to penalties or
 *    refunds, and always at the tier settled at the app-day's start.
 */

import {
  addDays,
  appDateOf,
  boundariesBetween,
  isWeekBoundaryClose,
  weekKeyAfter,
  weekKeyOf,
  weekdayOf,
} from './time.js';
import { dailyTargetOf, isRostered, tasksOfType } from './config.js';

/* ------------------------------------------------------------------ *
 * World construction and small immutable helpers                      *
 * ------------------------------------------------------------------ */

export function createWorld(nowMs, cfg) {
  const appDate = appDateOf(nowMs, cfg);
  const weekKey = weekKeyOf(appDate, cfg);
  const world = {
    state: {
      lastProcessedTimestamp: nowMs,
      // Nothing before install is settled; the first close is today's.
      lastSettledAppDate: addDays(appDate, -1),
      balance: 0,
      currentStreak: 0,
      currentWeekKey: weekKey,
      installedAt: nowMs,
    },
    completions: [],
    failures: [],
    skips: [],
    redemptions: [],
    missedTargets: [],
  };
  return grantWeeklySkips(world, weekKey, nowMs, cfg);
}

const clone = (world) => ({
  state: { ...world.state },
  completions: world.completions.slice(),
  failures: world.failures.slice(),
  skips: world.skips.slice(),
  redemptions: world.redemptions.slice(),
  missedTargets: world.missedTargets.slice(),
});

/** Replace one record in a collection by id, leaving the rest untouched. */
function replaceById(list, id, patch) {
  return list.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/* ------------------------------------------------------------------ *
 * Ledger queries — every count is derived, nothing is denormalised    *
 * ------------------------------------------------------------------ */

/**
 * A voided completion — undone as a misclick — counts for NOTHING: not quota,
 * not dailyTarget, not bonus headroom, not anchor status, not the streak. It
 * stays in the ledger and in the export regardless; undo marks, never deletes.
 * Every count below goes through this filter, which is why there is no way to
 * forget it in one place and not another.
 */
export const isLive = (c) => !c.voidedAt;

export const liveCompletions = (world) => world.completions.filter(isLive);

export const completionsOnDay = (world, appDate) =>
  world.completions.filter((c) => isLive(c) && c.appDate === appDate);

export const completionsOfTaskOnDay = (world, taskId, appDate) =>
  world.completions.filter((c) => isLive(c) && c.taskId === taskId && c.appDate === appDate);

export const completionsOfTaskInWeek = (world, taskId, weekKey) =>
  world.completions.filter((c) => isLive(c) && c.taskId === taskId && c.weekKey === weekKey);

export const openFailures = (world) => world.failures.filter((f) => f.resolvedAt === null);

export const availableSkips = (world) =>
  world.skips.filter((s) => s.spentAt === null && s.lapsedAt === null);

/** Did any anchor task get completed on this app-day? */
export function anchoredOn(world, appDate, cfg) {
  return completionsOnDay(world, appDate).some((c) => cfg.tasks[c.taskId]?.anchor === true);
}

/** Bonus points already banked in a week — drives the weekly cap headroom. */
export function bonusPointsAwardedInWeek(world, weekKey, cfg) {
  return world.completions
    .filter((c) => isLive(c) && c.weekKey === weekKey && cfg.tasks[c.taskId]?.type === 'bonus')
    .reduce((sum, c) => sum + (c.pointsAwarded ?? 0), 0);
}

export function bonusHeadroom(world, weekKey, cfg) {
  return Math.max(0, cfg.bonusWeeklyCap - bonusPointsAwardedInWeek(world, weekKey, cfg));
}

/* ------------------------------------------------------------------ *
 * Multiplier                                                          *
 * ------------------------------------------------------------------ */

export function tierFor(streak, cfg) {
  let tier = { name: null, multiplier: 1, at: 0 };
  for (const t of cfg.streak.tiers) if (streak >= t.at) tier = t;
  return tier;
}

/** Earned points only. Never applied to penalties or refunds. */
export function award(points, tier) {
  return Math.round(points * tier.multiplier);
}

/* ------------------------------------------------------------------ *
 * Balance                                                             *
 * ------------------------------------------------------------------ */

function credit(world, amount) {
  world.state.balance += amount;
  return world;
}

/**
 * Apply a penalty against the floor and report what it ACTUALLY cost.
 * The gap between `penalty` and `actualDeduction` is why refunds use the
 * latter — refunding the config penalty at the floor would mint free points.
 */
function debitWithFloor(world, penalty, cfg) {
  const before = world.state.balance;
  const after = Math.max(cfg.balanceFloor, before - penalty);
  world.state.balance = after;
  return before - after;
}

/* ------------------------------------------------------------------ *
 * Completing a task (tap time)                                        *
 * ------------------------------------------------------------------ */

/**
 * Record a completion. Callers must run rollover(world, now, cfg) first, so
 * that a tap after a day boundary lands in the new app-day with the closing
 * day already settled.
 *
 * Returns { ok, world, completion?, reason? }. Rejections are complete no-ops
 * and return the SAME world object.
 */
export function completeTask(world, { taskId, timestamp, value = null, poolLabel = null }, cfg) {
  const task = cfg.tasks[taskId];
  if (!task) return { ok: false, reason: 'unknown-task', world };

  const appDate = appDateOf(timestamp, cfg);
  const weekKey = weekKeyOf(appDate, cfg);
  const tier = tierFor(world.state.currentStreak, cfg);
  const doneToday = completionsOfTaskOnDay(world, taskId, appDate).length;
  const doneThisWeek = completionsOfTaskInWeek(world, taskId, weekKey).length;

  // dailyCap is the one bonus limit knowable at tap time: it caps the number
  // of completions, not their points, so it needs no future knowledge.
  if (task.type === 'bonus' && doneToday >= task.dailyCap) {
    return { ok: false, reason: 'daily-cap', world };
  }

  let pointsAwarded = null;
  let gateReason = null;
  let settledAt = timestamp;

  if (task.type === 'bonus') {
    // Deferred to day close, when anchor status and weekly headroom are final.
    pointsAwarded = null;
    settledAt = null;
  } else if (task.type === 'quota') {
    const past = doneThisWeek >= task.target;
    if (past && !task.extraEarnsPoints) {
      pointsAwarded = 0;
      gateReason = 'over-target';
    } else {
      pointsAwarded = award(task.points, tier);
    }
  } else if (task.type === 'daily') {
    const past = doneToday >= dailyTargetOf(task);
    if (past && !task.extraEarnsPoints) {
      pointsAwarded = 0;
      gateReason = 'over-target';
    } else {
      pointsAwarded = award(task.points, tier);
    }
  } else {
    // target and tracker: every completion earns; the recorded VALUE never
    // affects points, penalties, streaks or multipliers.
    pointsAwarded = award(task.points, tier);
  }

  const completion = {
    id: 'cmp:' + taskId + ':' + new Date(timestamp).toISOString(),
    taskId,
    taskType: task.type,
    label: task.label,
    timestamp,
    appDate,
    weekKey,
    pointsAwarded,
    multiplierApplied: pointsAwarded ? tier.multiplier : null,
    settledAt,
    gateReason,
    value,
    unit: task.unit ?? null,
    poolLabel,
    voidedAt: null,
    voidedRefund: null,
  };

  const next = clone(world);
  next.completions = [...next.completions, completion];
  if (pointsAwarded) credit(next, pointsAwarded);
  return { ok: true, world: next, completion };
}

/* ------------------------------------------------------------------ *
 * Undo — a misclick correction, deliberately small                    *
 * ------------------------------------------------------------------ */

/**
 * How many undos are left today.
 *
 * Derived from the ledger like everything else: undo is same-app-day only, so
 * the voided completions bearing today's appDate ARE today's undos. There is
 * no counter to drift, and the allowance resets at the day boundary for free
 * because tomorrow's appDate matches nothing voided today.
 */
export function undosUsedOn(world, appDate) {
  return world.completions.filter((c) => c.voidedAt && c.appDate === appDate).length;
}

export function undosRemaining(world, nowMs, cfg) {
  return Math.max(0, (cfg.undosPerDay ?? 0) - undosUsedOn(world, appDateOf(nowMs, cfg)));
}

/** Why a completion cannot be undone right now, or null if it can. */
export function undoBlockedReason(world, completion, nowMs, cfg) {
  if (!completion) return 'not-found';
  if (completion.voidedAt) return 'already-voided';

  const today = appDateOf(nowMs, cfg);
  // Same app-day only. Once the boundary has settled the day, the completion
  // has already fed penalties, the streak and bonus settlement — reopening it
  // would mean rescoring a closed day, which nothing in this app ever does.
  if (completion.appDate !== today) return 'day-closed';
  if (world.state.lastSettledAppDate && completion.appDate <= world.state.lastSettledAppDate) {
    return 'day-closed';
  }
  if (undosRemaining(world, nowMs, cfg) <= 0) return 'no-undos-left';
  return null;
}

/**
 * Undo a completion tapped by mistake.
 *
 * Writes `voidedAt` — never deletes — and takes back exactly what was awarded,
 * read off the record rather than recomputed from config, so a mid-week retune
 * cannot make an undo refund a different number than the tap paid. An unsettled
 * bonus (`pointsAwarded === null`) banked nothing, so it returns nothing; its
 * points simply flow back into the day's headroom by no longer counting.
 *
 * Rejections are complete no-ops and return the SAME world object.
 */
export function undoCompletion(world, completionId, nowMs, cfg) {
  const completion = world.completions.find((c) => c.id === completionId);
  const blocked = undoBlockedReason(world, completion, nowMs, cfg);
  if (blocked) return { ok: false, reason: blocked, world };

  const refund = completion.pointsAwarded ?? 0;
  if (refund < 0) {
    throw new Error(`refusing to undo ${completionId}: pointsAwarded is negative (${refund})`);
  }

  const next = clone(world);
  next.completions = replaceById(next.completions, completion.id, {
    voidedAt: nowMs,
    voidedRefund: refund,
  });
  next.state.balance -= refund;

  // Undo can only ever return the balance to where it stood before the tap —
  // never above it, whatever the tier is doing now.
  if (next.state.balance > world.state.balance) {
    throw new Error('undo raised the balance; refusing to persist a scoring error');
  }
  return { ok: true, world: next, refunded: refund, completion: next.completions.find((c) => c.id === completion.id) };
}

/* ------------------------------------------------------------------ *
 * Failures                                                            *
 * ------------------------------------------------------------------ */

/**
 * Write one Failure. Ids are deterministic — daily keys on the app-day, quota
 * keys on the week, because a quota shortfall belongs to a week rather than to
 * whichever Sunday closed it. A replay that re-derives the same id is a no-op
 * rather than a duplicate, and never deducts twice.
 */
function writeFailure(world, { task, kind, incurredAppDate, incurredWeekKey, at }, cfg) {
  const scope = kind === 'quota' ? incurredWeekKey : incurredAppDate;
  const prefix = 'fail:' + task.id + ':' + scope + ':';
  const n = world.failures.filter((f) => f.id.startsWith(prefix)).length;
  const id = prefix + n;
  if (world.failures.some((f) => f.id === id)) return world;

  const actualDeduction = debitWithFloor(world, task.penalty, cfg);
  world.failures = [
    ...world.failures,
    {
      id,
      taskId: task.id,
      label: task.label,
      kind,
      incurredAppDate,
      incurredWeekKey,
      // Live from now until the boundary that ends the FOLLOWING week.
      redeemThroughWeekKey: weekKeyAfter(incurredWeekKey),
      penalty: task.penalty,
      actualDeduction,
      createdAt: at,
      resolvedAt: null,
      resolvedVia: null,
      resolvedBySkipId: null,
    },
  ];
  return world;
}

/* ------------------------------------------------------------------ *
 * Skips                                                               *
 * ------------------------------------------------------------------ */

function grantWeeklySkips(world, weekKey, at, cfg) {
  const next = clone(world);
  for (let n = 0; n < cfg.skipsPerWeek; n += 1) {
    const id = 'skip:grant:' + weekKey + ':' + n;
    if (next.skips.some((s) => s.id === id)) continue;
    next.skips = [
      ...next.skips,
      {
        id,
        source: 'weekly-grant',
        grantedWeekKey: weekKey,
        grantedAt: at,
        redemptionId: null,
        spentAt: null,
        spentOnFailureId: null,
        lapsedAt: null,
      },
    ];
  }
  return next;
}

/**
 * Spend one skip against an open Failure.
 *
 * Guarded: any failure with a non-null resolvedAt is rejected, which covers
 * both an entry already cleared by a skip and one that expired at a week
 * boundary. An expired entry is permanently unredeemable. The guard runs
 * before a skip is consumed and before any balance change, so a rejection is
 * a complete no-op and returns the SAME world object.
 */
export function spendSkip(world, failureId, nowMs) {
  const failure = world.failures.find((f) => f.id === failureId);
  if (!failure) return { ok: false, reason: 'not-found', world };
  if (failure.resolvedAt !== null) {
    return { ok: false, reason: failure.resolvedVia === 'expired' ? 'expired' : 'already-resolved', world };
  }
  // Weekly grants lapse at the week boundary; purchases never do, so spend
  // the perishable one first.
  const skip =
    availableSkips(world).find((s) => s.source === 'weekly-grant') ?? availableSkips(world)[0];
  if (!skip) return { ok: false, reason: 'no-skips', world };

  const next = clone(world);
  next.failures = replaceById(next.failures, failure.id, {
    resolvedAt: nowMs,
    resolvedVia: 'skip',
    resolvedBySkipId: skip.id,
  });
  next.skips = replaceById(next.skips, skip.id, {
    spentAt: nowMs,
    spentOnFailureId: failure.id,
  });
  // Refund exactly what the miss cost, never the configured penalty.
  credit(next, failure.actualDeduction);
  return { ok: true, world: next, refunded: failure.actualDeduction, skipId: skip.id };
}

/* ------------------------------------------------------------------ *
 * Settlement                                                          *
 * ------------------------------------------------------------------ */

/**
 * Settle one app-day close. Ordering matters and is not negotiable:
 *
 *   1. bonus completions for the closing day (before the streak moves, so
 *      they use the tier settled at that day's start);
 *   2. daily misses for the closing day, tagged forward to the next week;
 *   3. at a week boundary: expire the PREVIOUS cycle's failures, then write
 *      this week's quota shortfalls tagged forward, then target bonuses,
 *      then skips;
 *   4. the streak, last.
 *
 * Writing shortfalls before expiring would erase them in the same pass — and
 * a Sunday daily miss with them, since the last day boundary of a week IS the
 * week boundary.
 */
export function settleDayClose(world, closingAppDate, boundaryInstant, cfg) {
  // A day is never settled twice, even if a caller replays boundaries.
  if (world.state.lastSettledAppDate && closingAppDate <= world.state.lastSettledAppDate) {
    return world;
  }

  const next = clone(world);
  const D = closingAppDate;
  const weekday = weekdayOf(D);
  const weekKey = weekKeyOf(D, cfg);
  const tier = tierFor(next.state.currentStreak, cfg); // settled at D's START
  const anchored = anchoredOn(next, D, cfg);

  // --- 1. bonus settlement -------------------------------------------------
  let headroom = bonusHeadroom(next, weekKey, cfg);
  const unsettled = completionsOnDay(next, D)
    .filter((c) => c.taskType === 'bonus' && c.pointsAwarded === null)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const c of unsettled) {
    const task = cfg.tasks[c.taskId];
    let pts = 0;
    let gateReason = null;
    if (cfg.bonusRequiresAnchor && !anchored) {
      gateReason = 'anchor-missing';
    } else {
      const full = award(task.points, tier);
      pts = Math.max(0, Math.min(full, headroom));
      headroom -= pts;
      if (pts < full) gateReason = 'weekly-cap';
    }
    next.completions = replaceById(next.completions, c.id, {
      pointsAwarded: pts,
      multiplierApplied: pts ? tier.multiplier : null,
      settledAt: boundaryInstant,
      gateReason,
    });
    if (pts) credit(next, pts);
  }

  // --- 2. daily misses for the closing day ---------------------------------
  for (const task of tasksOfType(cfg, 'daily')) {
    if (!isRostered(task, weekday)) continue;
    const short = Math.max(0, dailyTargetOf(task) - completionsOfTaskOnDay(next, task.id, D).length);
    for (let n = 0; n < short; n += 1) {
      writeFailure(
        next,
        { task, kind: 'daily', incurredAppDate: D, incurredWeekKey: weekKey, at: boundaryInstant },
        cfg,
      );
    }
  }

  // --- 3. week close -------------------------------------------------------
  if (isWeekBoundaryClose(D, cfg)) {
    // a. expire the previous cycle — resolve in place, never delete.
    next.failures = next.failures.map((f) =>
      f.resolvedAt === null && f.redeemThroughWeekKey === weekKey
        ? { ...f, resolvedAt: boundaryInstant, resolvedVia: 'expired' }
        : f,
    );

    // c. quota shortfalls for the week that just closed.
    for (const task of tasksOfType(cfg, 'quota')) {
      const short = Math.max(0, task.target - completionsOfTaskInWeek(next, task.id, weekKey).length);
      for (let n = 0; n < short; n += 1) {
        writeFailure(
          next,
          { task, kind: 'quota', incurredAppDate: D, incurredWeekKey: weekKey, at: boundaryInstant },
          cfg,
        );
      }
    }

    // d. target bonuses — once, at the tier settled at D's start.
    for (const task of tasksOfType(cfg, 'target')) {
      const met = completionsOfTaskInWeek(next, task.id, weekKey).length >= task.target;
      const id = (met ? 'tb:' : 'miss:') + task.id + ':' + weekKey;
      if (met) {
        if (next.completions.some((c) => c.id === id)) continue;
        const pts = award(task.targetBonus, tier);
        next.completions = [
          ...next.completions,
          {
            id,
            taskId: task.id,
            taskType: 'target-bonus',
            label: task.label + ' — target bonus',
            timestamp: boundaryInstant,
            appDate: D,
            weekKey,
            pointsAwarded: pts,
            multiplierApplied: tier.multiplier,
            settledAt: boundaryInstant,
            gateReason: null,
            value: null,
            unit: null,
            poolLabel: null,
            voidedAt: null,
            voidedRefund: null,
          },
        ];
        credit(next, pts);
      } else if (!next.missedTargets.some((m) => m.id === id)) {
        // Display only: a missed target is not a failure and not redeemable.
        next.missedTargets = [
          ...next.missedTargets,
          {
            id,
            taskId: task.id,
            label: task.label,
            weekKey,
            target: task.target,
            reached: completionsOfTaskInWeek(next, task.id, weekKey).length,
            forfeited: task.targetBonus,
            at: boundaryInstant,
          },
        ];
      }
    }

    // e. skips: weekly grants lapse, purchases are untouched.
    next.skips = next.skips.map((s) =>
      s.source === 'weekly-grant' &&
      s.grantedWeekKey === weekKey &&
      s.spentAt === null &&
      s.lapsedAt === null
        ? { ...s, lapsedAt: boundaryInstant }
        : s,
    );
    const granted = grantWeeklySkips(next, weekKeyAfter(weekKey), boundaryInstant, cfg);
    next.skips = granted.skips;
    next.state.currentWeekKey = weekKeyAfter(weekKey);
  }

  // --- 4. streak, last -----------------------------------------------------
  next.state.currentStreak = anchored ? next.state.currentStreak + 1 : 0;
  next.state.lastSettledAppDate = D;
  return next;
}

/**
 * Lazy, idempotent rollover. Settles every elapsed boundary in order.
 * Never scheduled: the caller runs this on app open.
 *
 * A backward clock jump (now < lastProcessedTimestamp) processes nothing and
 * undoes nothing — the same world object is returned.
 */
export function rollover(world, nowMs, cfg) {
  if (!(nowMs > world.state.lastProcessedTimestamp)) return world;

  let next = world;
  for (const b of boundariesBetween(world.state.lastProcessedTimestamp, nowMs, cfg)) {
    next = settleDayClose(next, b.closingAppDate, b.instant, cfg);
  }
  if (next === world) next = clone(world);
  else next = clone(next);
  next.state.lastProcessedTimestamp = nowMs;
  return next;
}

/* ------------------------------------------------------------------ *
 * Views — pure derivations the UI will render in stage 2              *
 * ------------------------------------------------------------------ */

/**
 * Today's bonus points, gate-aware.
 *
 * The anchor gate is knowable NOW, so a locked day reports `locked: true`
 * rather than advertising points settlement is guaranteed to award as 0. The
 * weekly cap stays an estimate; the tier cannot drift, being fixed for the
 * whole app-day.
 */
export function pendingSummary(world, nowMs, cfg) {
  const appDate = appDateOf(nowMs, cfg);
  const weekKey = weekKeyOf(appDate, cfg);
  const tier = tierFor(world.state.currentStreak, cfg);
  const unsettled = completionsOnDay(world, appDate).filter(
    (c) => c.taskType === 'bonus' && c.pointsAwarded === null,
  );
  const pending = unsettled.reduce((sum, c) => sum + award(cfg.tasks[c.taskId].points, tier), 0);
  const anchoredToday = anchoredOn(world, appDate, cfg);
  return {
    appDate,
    pending,
    count: unsettled.length,
    anchoredToday,
    locked: cfg.bonusRequiresAnchor && !anchoredToday,
    headroom: bonusHeadroom(world, weekKey, cfg),
    tier,
  };
}

/**
 * Open failures collapsed for display.
 *
 * Grouped on (taskId, penalty, actualDeduction) — actualDeduction is part of
 * the key, not just the sort, because two misses of the same task differ once
 * the floor has clamped one, and rows in a group must be interchangeable when
 * a skip is spent against one of them. Sorted by what a skip actually returns.
 */
export function groupedFailures(world) {
  const groups = new Map();
  for (const f of openFailures(world)) {
    const key = f.taskId + '|' + f.penalty + '|' + f.actualDeduction;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        taskId: f.taskId,
        label: f.label,
        penalty: f.penalty,
        actualDeduction: f.actualDeduction,
        count: 0,
        ids: [],
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.ids.push(f.id);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, totalPenalty: g.penalty * g.count, totalActual: g.actualDeduction * g.count }))
    .sort(
      (a, b) =>
        b.actualDeduction - a.actualDeduction ||
        b.penalty - a.penalty ||
        a.taskId.localeCompare(b.taskId),
    );
}

/** Shop cooldown and affordability, all derived — nothing cached. */
export function shopState(world, nowMs, cfg) {
  const { pending, locked } = pendingSummary(world, nowMs, cfg);
  return cfg.shop.map((item) => {
    const last = world.redemptions
      .filter((r) => r.itemName === item.name)
      .reduce((max, r) => Math.max(max, r.timestamp), -Infinity);
    const cooldownMs = (item.cooldownDays ?? 0) * 86400000;
    const availableAt = last === -Infinity ? -Infinity : last + cooldownMs;
    const onCooldown = nowMs < availableAt;
    const negative = world.state.balance < 0;
    const affordable = world.state.balance >= item.cost;
    return {
      ...item,
      onCooldown,
      cooldownRemainingMs: onCooldown ? availableAt - nowMs : 0,
      affordable,
      negativeBalance: negative,
      redeemable: affordable && !negative && !onCooldown,
      // Pending never makes an item redeemable; it only explains the tile.
      reachableWithPending: !affordable && world.state.balance + pending >= item.cost,
      pendingIsLocked: locked,
      shortfall: Math.max(0, item.cost - world.state.balance),
    };
  });
}

export function redeemItem(world, itemName, nowMs, cfg) {
  const state = shopState(world, nowMs, cfg).find((i) => i.name === itemName);
  if (!state) return { ok: false, reason: 'unknown-item', world };
  if (state.negativeBalance) return { ok: false, reason: 'negative-balance', world };
  if (state.onCooldown) return { ok: false, reason: 'cooldown', world };
  if (!state.affordable) return { ok: false, reason: 'unaffordable', world };

  const next = clone(world);
  const id = 'rdm:' + new Date(nowMs).toISOString();
  next.state.balance -= state.cost;
  next.redemptions = [
    ...next.redemptions,
    { id, itemName, cost: state.cost, timestamp: nowMs, balanceAfter: next.state.balance },
  ];
  // The Skip Token is an ordinary item that also mints a skip. Purchased
  // skips never lapse.
  if (state.name === 'Skip Token') {
    next.skips = [
      ...next.skips,
      {
        id: 'skip:buy:' + new Date(nowMs).toISOString(),
        source: 'purchase',
        grantedWeekKey: weekKeyOf(appDateOf(nowMs, cfg), cfg),
        grantedAt: nowMs,
        redemptionId: id,
        spentAt: null,
        spentOnFailureId: null,
        lapsedAt: null,
      },
    ];
  }
  return { ok: true, world: next };
}

/** Full dump for the JSON export — every store, in full. */
export function exportAll(world, cfg) {
  return {
    exportedFrom: 'TrackerApp',
    state: world.state,
    completions: world.completions,
    failures: world.failures,
    skips: world.skips,
    redemptions: world.redemptions,
    missedTargets: world.missedTargets,
    configSnapshot: cfg,
  };
}
