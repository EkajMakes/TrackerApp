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

  const row = el('div', 'hdr-row');
  const balance = el('span', 'hdr-balance', header.balance);
  if (header.negative) balance.classList.add('is-negative');
  row.append(balance, el('span', 'hdr-unit', 'pts'));

  // Gate-aware: a locked day says so instead of advertising points that
  // settlement is guaranteed to award as 0.
  const { pending, locked, count } = header.pending;
  if (count > 0) {
    const tag = el('span', 'hdr-pending', locked ? `+${pending} locked` : `+${pending} pending`);
    if (locked) tag.classList.add('is-locked');
    row.append(tag);
  }
  root.append(row);

  const sub = el('div', 'hdr-sub');
  // The tier is the main motivational surface: each one looks distinctly
  // hotter than the last, and "no tier" reads as unlit rather than broken.
  const tierClass = header.tierName ? `tier-${header.tierName.toLowerCase()}` : 'tier-none';
  const tier = el('span', `hdr-tier ${tierClass}`);
  tier.append(el('span', 'hdr-tier-flame', header.tierName ? '◆' : '◇'));
  tier.append(el('span', null, header.tierName ? `${header.tierName} ${header.multiplier}x` : 'No tier'));
  sub.append(tier);
  sub.append(el('span', 'hdr-streak', `${header.streak}-day streak`));
  sub.append(el('span', null, `${header.skipsAvailable} skip${header.skipsAvailable === 1 ? '' : 's'}`));
  if (header.nextTier) {
    sub.append(el('span', 'hdr-next',
      `${header.nextTier.daysAway}d → ${header.nextTier.name}`));
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
