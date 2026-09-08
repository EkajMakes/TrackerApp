/**
 * ui/history.js — completions by week, the weight chart, the running balance.
 *
 * The weight chart is VALUE ONLY. No points, penalties, multiplier or any
 * other scoring signal appears next to the number: recording the entry earns
 * the points, the number itself never means anything to the economy.
 */

import { clear, el, empty } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const W = 320;
const H = 150;
const PAD = 8;

/** Maps an already-derived series to pixels. Geometry only. */
function lineChart(points, { min, range }, colour, { area = false } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  if (points.length < 2) return svg;

  const x = (i) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / range) * (H - PAD * 2);
  const coords = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);

  if (area) {
    const fill = document.createElementNS(SVG, 'polygon');
    fill.setAttribute('points', `${x(0)},${H} ${coords.join(' ')} ${x(points.length - 1)},${H}`);
    fill.setAttribute('fill', colour);
    fill.setAttribute('opacity', '0.14');
    svg.append(fill);
  }

  const line = document.createElementNS(SVG, 'polyline');
  line.setAttribute('points', coords.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', colour);
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(line);

  const last = document.createElementNS(SVG, 'circle');
  last.setAttribute('cx', x(points.length - 1));
  last.setAttribute('cy', y(points.at(-1)));
  last.setAttribute('r', '3.5');
  last.setAttribute('fill', colour);
  svg.append(last);
  return svg;
}

function weekCard(week) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('div', 'card-title', week.isCurrent ? `Week of ${week.label} · current` : `Week of ${week.label}`));
  const net = el('div', 'card-net', week.net > 0 ? `+${week.net}` : String(week.net));
  net.classList.add(week.net >= 0 ? 'pos' : 'neg');
  head.append(net);
  card.append(head);

  for (const row of week.tasks) {
    const kv = el('div', 'kv');
    kv.append(el('span', null, `${row.label} ×${row.count}`));
    if (row.points) kv.append(el('b', null, `+${row.points}`));
    else if (row.pending) kv.append(el('b', null, 'settles tonight'));
    else kv.append(el('b', null, '0'));
    card.append(kv);
  }
  if (week.penalised) {
    const kv = el('div', 'kv');
    kv.append(el('span', null, 'penalties'));
    const v = el('b', null, `−${week.penalised}`);
    v.classList.add('neg');
    kv.append(v);
    card.append(kv);
  }
  if (week.refunded) {
    const kv = el('div', 'kv');
    kv.append(el('span', null, 'refunded by skips'));
    kv.append(el('b', null, `+${week.refunded}`));
    card.append(kv);
  }
  return card;
}

export function renderHistory(root, view, actions) {
  clear(root);
  const { history } = view;

  /* --- running balance ------------------------------------------------- */
  root.append(el('h2', 'sec', 'Running balance'));
  const balCard = el('div', 'card');
  const balHead = el('div', 'card-head');
  balHead.append(el('div', 'card-title', `${history.balance.current} pts`));
  balHead.append(el('div', 'card-net', `floor ${history.balance.floor}`));
  balCard.append(balHead);
  if (history.balance.points.length > 1) {
    balCard.append(lineChart(history.balance.points.map((p) => p.balance), history.balance, '#58a6ff', { area: true }));
    const foot = el('div', 'chart-foot');
    foot.append(el('span', null, `low ${history.balance.min}`), el('span', null, `high ${history.balance.max}`));
    balCard.append(foot);
  } else {
    balCard.append(empty('Not enough history to chart yet.'));
  }
  root.append(balCard);

  /* --- weight: the value, and nothing else ----------------------------- */
  root.append(el('h2', 'sec', 'Weight'));
  const wCard = el('div', 'card');
  if (history.weight.entries.length) {
    const head = el('div', 'card-head');
    head.append(el('div', 'card-title', `${history.weight.latest} ${history.weight.unit ?? ''}`.trim()));
    head.append(el('div', 'card-net', `${history.weight.entries.length} entries`));
    wCard.append(head);
    wCard.append(lineChart(history.weight.entries.map((e) => e.value), history.weight, '#3fb950'));
    // Each end of the axis is labelled with its own entry — never a date
    // paired with the series min/max, which reads as a value on that day.
    const first = history.weight.entries[0];
    const last = history.weight.entries.at(-1);
    const foot = el('div', 'chart-foot');
    foot.append(
      el('span', null, `${first.label} · ${first.value}`),
      el('span', null, `${last.label} · ${last.value}`),
    );
    wCard.append(foot);
  } else {
    wCard.append(empty('No weight entries recorded yet.'));
  }
  root.append(wCard);

  /* --- completions by week --------------------------------------------- */
  root.append(el('h2', 'sec', 'Completions by week'));
  if (!history.weeks.length) root.append(empty('No completions recorded yet.'));
  for (const week of history.weeks) root.append(weekCard(week));

  /* --- redemptions ----------------------------------------------------- */
  if (history.redemptions.length) {
    root.append(el('h2', 'sec', 'Redemptions'));
    const card = el('div', 'card');
    for (const r of history.redemptions) {
      const kv = el('div', 'kv');
      kv.append(el('span', null, r.label));
      const v = el('b', null, `−${r.cost}`);
      v.classList.add('neg');
      kv.append(v);
      card.append(kv);
    }
    root.append(card);
  }

  /* --- resolved failures: retained, never deleted ----------------------- */
  if (history.resolvedFailures.length) {
    root.append(el('h2', 'sec', 'Resolved failures'));
    const card = el('div', 'card');
    for (const f of history.resolvedFailures.slice(0, 40)) {
      const kv = el('div', 'kv');
      kv.append(el('span', null, `${f.label} · ${f.dateLabel}`));
      kv.append(el('b', null, f.resolvedVia === 'skip' ? `skipped +${f.actualDeduction}` : 'expired'));
      card.append(kv);
    }
    root.append(card);
  }

  const btn = el('button', 'btn btn-ghost', 'Export all data as JSON');
  btn.type = 'button';
  btn.addEventListener('click', () => actions.exportData());
  root.append(btn);
}
