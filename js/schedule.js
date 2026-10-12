/**
 * schedule.js — PURE. Reads a parsed schedule.json and answers "what am I
 * meant to be doing right now".
 *
 * No DOM, no IndexedDB, no Date.now(). The instant arrives as an argument,
 * exactly as it does in the engine, so the whole thing is testable under
 * `node --test` and the tab can be driven to any moment.
 *
 * Two things here are easy to get wrong and are therefore handled once:
 *
 *  - **24+ notation.** A block ending "24:30" means 12:30am the NEXT morning,
 *    and "25:30" means 1:30am. Parsing those as 0:30 and 1:30 would sort them
 *    to the top of the day and break every comparison. Minutes are kept as an
 *    offset from the day's own midnight, so 24:30 is simply 1470 and sorts
 *    after 23:00 without special-casing.
 *
 *  - **The app-day, not the weekday.** The schedule shown is the one for the
 *    app-day, which runs from the 02:00 boundary. At 01:00 on a Tuesday you
 *    are still inside Monday's app-day, so Monday's blocks are the right
 *    answer — the same rule the rest of the app settles on.
 */

import { addDays, appDateOf, parseDate, wallToInstant, weekdayOf } from './time.js';

const MIN = 60000;

/** "09:30" → 570, "24:30" → 1470. Minutes from this day's own midnight. */
export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!match) throw new Error(`unparseable schedule time: ${text}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) throw new Error(`minutes out of range: ${text}`);
  return hours * 60 + minutes;
}

/** 1470 → "12:30am". Display only; the number stays the source of truth. */
export function formatClock(minutes) {
  const total = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(total / 60);
  const mins = total % 60;
  const suffix = hour24 < 12 ? 'am' : 'pm';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(mins).padStart(2, '0')}${suffix}`;
}

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / MIN));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The blocks for one app-day, as absolute instants.
 *
 * Offsets are measured from the labelled date's midnight, so a 24:30 block
 * resolves to 00:30 the following morning without any date arithmetic here —
 * `wallToInstant` is given hour 24 and the zone handles the rollover, DST
 * included.
 */
export function blocksForDay(schedule, appDate, cfg) {
  const weekday = weekdayOf(appDate);
  const raw = schedule?.days?.[weekday] ?? [];
  const { timezone } = cfg.dayBoundary;
  const date = parseDate(appDate);

  return raw
    .map(([from, to, label, category, sublabel], index) => {
      const startMin = parseClock(from);
      const endMin = parseClock(to);
      const at = (minutes) =>
        wallToInstant(
          { ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 },
          timezone,
        );
      const meta = schedule?.categories?.[category] ?? null;
      return {
        id: `${appDate}:${index}`,
        label,
        sublabel: sublabel || null,
        category,
        categoryLabel: meta?.label ?? category,
        color: meta?.color ?? null,
        startMin,
        endMin,
        start: at(startMin),
        end: at(endMin),
        timeRange: `${formatClock(startMin)} – ${formatClock(endMin)}`,
        // True when the block runs past midnight into the next calendar day.
        pastMidnight: startMin >= 1440,
      };
    })
    // Sorted on the offset, which is exactly why 24:30 lands after 23:00.
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
}

/**
 * The whole schedule view for one app-day at one instant.
 *
 * `state` on each block is 'past' | 'current' | 'future'. When the instant
 * falls between blocks, `gap` names the opening and what comes next.
 */
export function scheduleForDay(schedule, appDate, nowMs, cfg) {
  const blocks = blocksForDay(schedule, appDate, cfg).map((block) => {
    const state = nowMs >= block.end ? 'past' : nowMs >= block.start ? 'current' : 'future';
    return {
      ...block,
      state,
      remainingMs: state === 'current' ? block.end - nowMs : null,
      remainingLabel: state === 'current' ? `${formatDuration(block.end - nowMs)} left` : null,
    };
  });

  const current = blocks.find((b) => b.state === 'current') ?? null;
  const next = blocks.find((b) => b.state === 'future') ?? null;

  // A gap only exists when nothing is running AND the day has not finished.
  let gap = null;
  if (!current && next) {
    gap = {
      until: next.start,
      untilLabel: formatClock(next.startMin),
      nextLabel: next.label,
      remainingLabel: formatDuration(next.start - nowMs),
    };
  }

  const dayStart = blocks[0]?.start ?? null;
  const dayEnd = blocks.at(-1)?.end ?? null;
  const withinDay = dayStart !== null && nowMs >= dayStart && nowMs <= dayEnd;

  return {
    appDate,
    weekday: weekdayOf(appDate),
    blocks,
    current,
    next,
    gap,
    // Where the now-line sits, as a fraction of the day's span. Null before the
    // first block and after the last, so the line is simply not drawn.
    nowFraction: withinDay && dayEnd > dayStart ? (nowMs - dayStart) / (dayEnd - dayStart) : null,
    finished: dayEnd !== null && nowMs > dayEnd,
    notStarted: dayStart !== null && nowMs < dayStart,
    empty: blocks.length === 0,
  };
}

/**
 * The day the Schedule tab opens on: the APP-day containing `nowMs`, never the
 * wall-clock weekday. `offset` steps forward and back for browsing.
 */
export function scheduleView(schedule, nowMs, cfg, offset = 0) {
  const today = appDateOf(nowMs, cfg);
  const appDate = offset === 0 ? today : addDays(today, offset);
  return {
    ...scheduleForDay(schedule, appDate, nowMs, cfg),
    today,
    offset,
    isToday: appDate === today,
    categories: schedule?.categories ?? {},
  };
}
