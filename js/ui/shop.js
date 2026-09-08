/**
 * ui/shop.js — the catalog.
 *
 * Affordability comes from the SETTLED balance only; pending points never make
 * an item redeemable, they only explain a tile.
 */

import { clear, el, empty } from './dom.js';

function itemRow(item, actions) {
  const node = el('button', 'shop-item');
  node.type = 'button';
  const blocked = !item.redeemable;
  if (blocked) node.classList.add('is-blocked');

  const main = el('div', 'tile-main');
  main.append(el('div', 'tile-label', item.name));

  const bits = [];
  if (item.onCooldown) bits.push(`on cooldown · ${item.cooldownLabel} left`);
  if (item.negativeBalance) bits.push('balance is negative — climb out first');
  if (!item.affordable && !item.negativeBalance) {
    const short = `needs ${item.shortfall} more`;
    // §8.2: the tile explains itself, and the wording follows the gate state.
    if (!item.reachableWithPending) bits.push(short);
    else if (item.pendingIsLocked) bits.push(`${short} — pending is locked until an anchor task`);
    else bits.push(`${short} — pending points settle tonight`);
  }
  if (item.cooldownDays && !item.onCooldown) bits.push(`${item.cooldownDays}-day cooldown`);
  if (!bits.length) bits.push('ready');
  main.append(el('div', 'tile-meta', bits.join(' · ')));

  const cost = el('div', 'shop-cost', `${item.cost}`);
  if (item.redeemable) cost.classList.add('is-affordable');

  node.append(main, cost);
  node.disabled = blocked;
  node.addEventListener('click', () => actions.redeem(item));
  return node;
}

export function renderShop(root, view, actions) {
  clear(root);
  const { shop } = view;

  if (shop.negative) {
    const note = el('div', 'notice bad');
    note.append(
      el('strong', null, 'Nothing can be redeemed while the balance is negative. '),
      el('span', null, 'No automatic forgiveness — climbing back out is the point.'),
    );
    root.append(note);
  }

  root.append(el('h2', 'sec', `Shop · ${shop.balance} pts settled`));
  if (!shop.items.length) return void root.append(empty('No shop items configured.'));
  for (const item of shop.items) root.append(itemRow(item, actions));
}
