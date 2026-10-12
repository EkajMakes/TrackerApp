/**
 * ui/today.js — the roster for the current weekday.
 *
 * Renders `view.today` and `view.header`; computes nothing. Every number,
 * label, gate state and progress figure arrives already derived.
 */

import { clear, el, empty, signed } from './dom.js';

/* ---------------- header (pinned on every tab) ---------------- */

export function renderHeader(root, header) {
  clear(root);

  /* The tier is the headline. It is the thing this app is for: the number
     that only moves when the streak does. Points sit beneath it. */
  const tierWrap = el('div', `hdr-tier-block tier-${header.tierSlug}`);
  if (header.tierColor) tierWrap.style.setProperty('--tier', header.tierColor);
  if (header.beyond) tierWrap.classList.add('is-beyond');
  if (header.atCap) tierWrap.classList.add('is-capped');
  if (header.streak === 0) tierWrap.classList.add('is-cold');

  const name = el('div', 'hdr-tier-name', header.tierName);
  const mult = el('div', 'hdr-tier-mult', `${header.multiplier.toFixed(2)}x`);
  const top = el('div', 'hdr-tier-top');
  top.append(name, mult);
  tierWrap.append(top);

  const ladder = el('div', 'hdr-tier-progress', header.progress.text);
  tierWrap.append(ladder);
  root.append(tierWrap);

  /* Points — a score now, never a balance. */
  const row = el('div', 'hdr-row');
  const points = el('span', 'hdr-balance', header.balance);
  if (header.negative) points.classList.add('is-negative');
  row.append(points, el('span', 'hdr-unit', 'points'));

  const { pending, locked, count } = header.pending;
  if (count > 0) {
    const tag = el('span', 'hdr-pending', locked ? `+${pending} locked` : `+${pending} pending`);
    if (locked) tag.classList.add('is-locked');
    row.append(tag);
  }
  root.append(row);

  const sub = el('div', 'hdr-sub');
  sub.append(el('span', 'hdr-streak', `${header.streak}-day streak`));
  sub.append(el('span', null, `${header.skipsAvailable} skip${header.skipsAvailable === 1 ? '' : 's'}`));
  if (header.isRecordNow && header.streak > 0) {
    sub.append(el('span', 'hdr-record', 'record'));
  } else if (header.recordStreak > 0) {
    // The fact, and the record it fell short of. No scolding.
    sub.append(el('span', 'hdr-record-gap', `best ${header.recordStreak}`));
  }
  root.append(sub);

  if (count > 0 && locked) {
    root.append(el('div', 'hdr-note', 'Complete an anchor task to unlock today’s bonus points.'));
  } else if (count > 0) {
    root.append(el('div', 'hdr-note', `Settles tonight. ${header.pending.headroom} bonus pts left this week.`));
  }
  if (header.atFloor) {
    root.append(el('div', 'hdr-note', `At the floor (${header.floor}). Penalties can’t take more.`));
  }
}

/**
 * A tier-up deserves a moment. Called by app.js when a completion raises the
 * tier, kept under 600ms, and skipped entirely under prefers-reduced-motion.
 */
export function celebrateTierUp(root, header) {
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const block = root.querySelector('.hdr-tier-block');
  if (!block) return;
  block.classList.remove('is-tier-up');
  void block.offsetWidth;
  block.classList.add('is-tier-up');
  const flash = el('div', 'tier-up-flash', header.tierName);
  block.append(flash);
  setTimeout(() => flash.remove(), 600);
}

/* ---------------- today ---------------- */

function progressLine(task) {
  if (!task.progress) return null;
  const { done, target, scope } = task.progress;
  const noun = scope === 'week' ? 'this week' : scope === 'cap' ? 'today (cap)' : 'today';
  const left = target - done;
  // How many are LEFT reads faster than a fraction when you are mid-set.
  if (left > 0 && scope !== 'cap') return `${done}/${target} ${noun} · ${left} to go`;
  return `${done}/${target} ${noun}`;
}

function tile(task, actions) {
  const node = el('button', 'tile');
  node.type = 'button';
  if (task.met) node.classList.add('is-met');
  if (task.locked) node.classList.add('is-locked');
  if (task.disabled) node.classList.add('is-disabled');

  const main = el('div', 'tile-main');
  const label = el('div', 'tile-label');
  label.append(el('span', null, task.label));
  if (task.flag) label.append(el('span', 'badge flag', task.flag));
  if (task.anchor) label.append(el('span', 'badge anchor', 'anchor'));
  if (task.locked) label.append(el('span', 'badge locked', 'locked'));
  main.append(label);

  const bits = [];
  const progress = progressLine(task);
  if (progress) bits.push(progress);
  if (task.type === 'target' && task.targetBonus) bits.push(`+${task.targetBonus} at target`);
  if (task.overTarget) bits.push('target met — extra pays 0');
  if (task.capReached) bits.push('daily cap reached');
  if (task.locked) bits.push('settles at 0 until an anchor lands');
  if (bits.length) main.append(el('div', 'tile-meta', bits.join(' · ')));

  if (task.progress && task.progress.scope !== 'cap') {
    const bar = el('div', 'bar');
    if (task.met) bar.classList.add('is-met');
    const fill = el('i');
    fill.style.width = `${Math.min(100, (task.progress.done / task.progress.target) * 100)}%`;
    bar.append(fill);
    main.append(bar);
  }

  const pts = el('div', 'tile-pts', signed(task.awardNow));
  if (task.awardNow === 0) pts.classList.add('is-zero');

  node.append(main, pts);
  // Locked bonus tiles stay TAPPABLE — the completion is still recorded.
  node.disabled = task.disabled;
  node.addEventListener('click', () => {
    // Under 300ms, and purely decorative: the action fires regardless.
    node.classList.remove('is-tapped');
    void node.offsetWidth;
    node.classList.add('is-tapped');
    if (task.awardNow > 0) flyPoints(node, signed(task.awardNow));
    actions.complete(task);
  });
  return node;
}

/** The points landing, briefly, where the tap happened. */
function flyPoints(tile, text) {
  const chip = el('span', 'fly', text);
  tile.append(chip);
  setTimeout(() => chip.remove(), 700);
}

/** Undo control: only present while the undo is genuinely available. */
function undoRow(task, undosRemaining, actions) {
  const row = el('div', 'undo-row');
  const btn = el('button', 'undo-btn');
  btn.type = 'button';
  btn.append(el('span', 'undo-icon', '↩'));
  btn.append(el('span', null, `undo · ${undosRemaining} left`));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.undo(task.undoable);
  });
  row.append(btn);
  return row;
}

export function renderToday(root, view, actions) {
  clear(root);
  const { today } = view;

  root.append(el('h2', 'sec', `${today.weekdayLabel} · ${today.dateLabel}`));

  if (today.locked) {
    const note = el('div', 'notice');
    note.append(
      el('strong', null, 'Bonus points are locked. '),
      el('span', null,
        'No anchor task completed yet today, so bonus taps will settle at 0 tonight. '
        + 'They are still recorded — finish an anchor task and they pay in full.'),
    );
    root.append(note);
  }

  const order = ['daily', 'quota', 'target', 'tracker', 'bonus'];
  const groups = new Map();
  for (const task of today.tasks) {
    if (!groups.has(task.type)) groups.set(task.type, []);
    groups.get(task.type).push(task);
  }

  const heading = {
    daily: 'Daily', quota: 'Weekly quota', target: 'Weekly target',
    tracker: 'Tracked', bonus: `Bonus · ${today.bonusHeadroom} of ${today.bonusWeeklyCap} pts left this week`,
  };

  let any = false;
  for (const type of order) {
    const tasks = groups.get(type);
    if (!tasks || !tasks.length) continue;
    any = true;
    root.append(el('h2', 'sec', heading[type]));
    for (const task of tasks) {
      const group = el('div', 'tile-group');
      group.append(tile(task, actions));
      // Once the day's allowance is spent the control disappears entirely
      // rather than sitting there disabled.
      if (task.undoable && today.undosRemaining > 0) {
        group.append(undoRow(task, today.undosRemaining, actions));
      }
      root.append(group);
    }
  }
  if (!any) root.append(empty('Nothing rostered for today.'));
}
