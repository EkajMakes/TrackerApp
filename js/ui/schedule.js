/**
 * ui/schedule.js — today's blocks as a vertical timeline.
 *
 * Renders `view.schedule`, which schedule.js derived; computes nothing itself,
 * including the "48 min left" figures and which block is current.
 *
 * The day shown is the APP-day, so at 1am you are still looking at yesterday's
 * plan, which is the one you are still living.
 */

import { clear, el, empty } from './dom.js';

const WEEKDAY_LABEL = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

function block(b) {
  const row = el('div', `sched-block is-${b.state}`);
  if (b.color) row.style.setProperty('--cat', b.color);

  const rail = el('div', 'sched-rail');
  rail.append(el('span', 'sched-dot'));
  row.append(rail);

  const body = el('div', 'sched-body');
  const head = el('div', 'sched-head');
  head.append(el('span', 'sched-label', b.label));
  if (b.state === 'current') head.append(el('span', 'badge now', 'now'));
  body.append(head);

  const meta = el('div', 'sched-meta');
  meta.append(el('span', 'sched-time', b.timeRange));
  meta.append(el('span', 'sched-cat', b.categoryLabel));
  body.append(meta);

  if (b.sublabel) body.append(el('div', 'sched-sub', b.sublabel));
  if (b.remainingLabel) body.append(el('div', 'sched-left', b.remainingLabel));

  row.append(body);
  return row;
}

export function renderSchedule(root, view, actions) {
  clear(root);
  const s = view.schedule;

  if (!s) {
    root.append(empty('schedule.json could not be loaded.'));
    return;
  }

  // Day stepper — opens on today, browses either way.
  const nav = el('div', 'sched-nav');
  const back = el('button', 'sched-step', '‹');
  back.type = 'button';
  back.addEventListener('click', () => actions.scheduleStep(-1));

  const title = el('div', 'sched-title');
  title.append(el('span', 'sched-day', WEEKDAY_LABEL[s.weekday] ?? s.weekday));
  title.append(el('span', 'sched-date', s.isToday ? 'today' : s.appDate));

  const forward = el('button', 'sched-step', '›');
  forward.type = 'button';
  forward.addEventListener('click', () => actions.scheduleStep(1));

  nav.append(back, title, forward);
  root.append(nav);

  if (!s.isToday) {
    const todayBtn = el('button', 'btn btn-ghost', 'Back to today');
    todayBtn.type = 'button';
    todayBtn.addEventListener('click', () => actions.scheduleStep(0));
    root.append(todayBtn);
  }

  if (s.empty) {
    root.append(empty('Nothing scheduled for this day.'));
    return;
  }

  // The banner answers "what now?" before the eye reaches the timeline.
  if (s.isToday) {
    if (s.current) {
      const banner = el('div', 'sched-banner is-live');
      if (s.current.color) banner.style.setProperty('--cat', s.current.color);
      banner.append(el('div', 'sched-banner-k', 'Right now'));
      banner.append(el('div', 'sched-banner-v', s.current.label));
      banner.append(el('div', 'sched-banner-s', `${s.current.timeRange} · ${s.current.remainingLabel}`));
      root.append(banner);
    } else if (s.gap) {
      const banner = el('div', 'sched-banner');
      banner.append(el('div', 'sched-banner-k', 'Open time'));
      banner.append(el('div', 'sched-banner-v', `Open until ${s.gap.untilLabel} — ${s.gap.nextLabel}`));
      banner.append(el('div', 'sched-banner-s', `${s.gap.remainingLabel} free`));
      root.append(banner);
    } else if (s.finished) {
      const banner = el('div', 'sched-banner');
      banner.append(el('div', 'sched-banner-k', 'Day complete'));
      banner.append(el('div', 'sched-banner-v', 'Nothing left on the schedule'));
      root.append(banner);
    } else if (s.notStarted) {
      const banner = el('div', 'sched-banner');
      banner.append(el('div', 'sched-banner-k', 'Not started'));
      banner.append(el('div', 'sched-banner-v', `First up: ${s.blocks[0].label}`));
      banner.append(el('div', 'sched-banner-s', s.blocks[0].timeRange));
      root.append(banner);
    }
  }

  const timeline = el('div', 'sched-timeline');
  let nowLineDrawn = false;
  for (const b of s.blocks) {
    // The now-line sits before the first block the moment has not reached.
    if (s.isToday && !nowLineDrawn && b.state === 'future' && !s.current) {
      timeline.append(el('div', 'now-line'));
      nowLineDrawn = true;
    }
    timeline.append(block(b));
    if (s.isToday && !nowLineDrawn && b.state === 'current') {
      timeline.append(el('div', 'now-line'));
      nowLineDrawn = true;
    }
  }
  root.append(timeline);
}
