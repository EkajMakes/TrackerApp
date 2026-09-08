/**
 * ui/failures.js — open entries and the skip action.
 *
 * Rows arrive already grouped on (taskId, penalty, actualDeduction) and sorted
 * by actualDeduction descending, so the most valuable redemption is on top.
 */

import { clear, el, empty } from './dom.js';

function groupRow(group, skipsAvailable, actions) {
  const row = el('div', 'fail-row');

  const main = el('div', 'fail-main');
  const label = el('div', 'fail-label', group.count > 1 ? `${group.label} ×${group.count}` : group.label);
  main.append(label);

  // Both numbers, always: the display penalty and what a skip actually returns.
  const nums = el('div', 'fail-nums');
  nums.append(el('span', 'fail-cost', `−${group.totalPenalty}`));
  nums.append(el('span', null,
    group.actualDeduction === group.penalty
      ? ` penalty · a skip refunds ${group.actualDeduction}`
      : ` penalty · a skip refunds ${group.actualDeduction} (the floor absorbed the rest)`));
  main.append(nums);

  const btn = el('button', 'btn btn-sm', 'Spend skip');
  btn.type = 'button';
  btn.disabled = skipsAvailable < 1;
  btn.addEventListener('click', () => actions.spendSkip(group));

  row.append(main, btn);
  return row;
}

export function renderFailures(root, view, actions) {
  clear(root);
  const { failures } = view;

  root.append(el('h2', 'sec',
    `Failure log · ${failures.skipsAvailable} skip${failures.skipsAvailable === 1 ? '' : 's'} available`));

  if (!failures.groups.length) {
    root.append(empty('No open failures. Nothing to redeem.'));
  } else {
    if (!failures.skipsAvailable) {
      const note = el('div', 'notice');
      note.append(el('strong', null, 'No skips left. '),
        el('span', null, 'Weekly grants refresh at the Monday boundary, or buy a Skip Token in the shop.'));
      root.append(note);
    }
    for (const group of failures.groups) root.append(groupRow(group, failures.skipsAvailable, actions));
  }

  if (failures.missedTargets.length) {
    root.append(el('h2', 'sec', 'Bonus missed'));
    const note = el('div', 'notice');
    note.append(el('span', null, 'A missed weekly target forfeits its bonus. It is not a failure and cannot be redeemed with a skip.'));
    root.append(note);
    for (const miss of failures.missedTargets) {
      const row = el('div', 'fail-row');
      const main = el('div', 'fail-main');
      main.append(el('div', 'fail-label', miss.label));
      main.append(el('div', 'fail-nums',
        `week of ${miss.weekLabel} · reached ${miss.reached}/${miss.target} · forfeited ${miss.forfeited}`));
      row.append(main);
      root.append(row);
    }
  }
}
