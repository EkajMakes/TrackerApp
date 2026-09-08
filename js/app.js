/**
 * app.js — entry point. Boots, settles, renders, and routes taps to actions.
 *
 * This is the only place that reads the clock or touches the DOM shell. It
 * owns no rules: reads go through rollover.js (which settles first and hands
 * back a view model), and every write goes through an action there, so every
 * user path runs rollover before it does anything else.
 */

import { loadConfig } from './config.js';
import {
  completeTaskAction,
  exportTracker,
  loadView,
  openTracker,
  redeemItemAction,
  spendSkipAction,
  viewOf,
} from './rollover.js';
import { renderHeader, renderToday } from './ui/today.js';
import { renderShop } from './ui/shop.js';
import { renderFailures } from './ui/failures.js';
import { renderHistory } from './ui/history.js';

const els = {
  boot: document.getElementById('boot'),
  app: document.getElementById('app'),
  header: document.getElementById('header'),
  tabs: document.getElementById('tabs'),
  badge: document.getElementById('tab-badge'),
  sheet: document.getElementById('sheet'),
  sheetTitle: document.getElementById('sheet-title'),
  sheetBody: document.getElementById('sheet-body'),
  toast: document.getElementById('toast'),
  views: {
    today: document.getElementById('view-today'),
    shop: document.getElementById('view-shop'),
    failures: document.getElementById('view-failures'),
    history: document.getElementById('view-history'),
  },
};

let cfg = null;
let db = null;
let tab = 'today';
let toastTimer = null;

const now = () => Date.now();

/* ---------------- chrome ---------------- */

function toast(message, bad = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('bad', bad);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function closeSheet() {
  els.sheet.hidden = true;
  els.sheetBody.replaceChildren();
}

/** Ask for a number (weight/tracker). Resolves to a value or null. */
function askValue(task) {
  return new Promise((resolve) => {
    els.sheetTitle.textContent = task.unit ? `${task.label} (${task.unit})` : task.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.step = 'any';
    const save = document.createElement('button');
    save.className = 'btn';
    save.type = 'button';
    save.textContent = 'Save';
    const submit = () => {
      const value = Number.parseFloat(input.value);
      if (!Number.isFinite(value)) return toast('Enter a number', true);
      closeSheet();
      resolve(value);
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    els.sheetBody.replaceChildren(input, save);
    els.sheet.hidden = false;
    els.sheet.dataset.resolve = 'value';
    els.sheet._cancel = () => resolve(null);
    input.focus();
  });
}

/** Pick a label from a bonus task's pool. Resolves to a label or null. */
function askPool(task) {
  return new Promise((resolve) => {
    els.sheetTitle.textContent = task.label;
    const options = task.pool.map((label) => {
      const btn = document.createElement('button');
      btn.className = 'pool-opt';
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => { closeSheet(); resolve(label); });
      return btn;
    });
    els.sheetBody.replaceChildren(...options);
    els.sheet.hidden = false;
    els.sheet._cancel = () => resolve(null);
  });
}

/* ---------------- rendering ---------------- */

function paint(view) {
  renderHeader(els.header, view.header);
  if (tab === 'today') renderToday(els.views.today, view, actions);
  if (tab === 'shop') renderShop(els.views.shop, view, actions);
  if (tab === 'failures') renderFailures(els.views.failures, view, actions);
  if (tab === 'history') renderHistory(els.views.history, view, actions);

  const open = view.failures.groups.reduce((sum, g) => sum + g.count, 0);
  els.badge.textContent = open;
  els.badge.hidden = open === 0;
}

/** Settle and repaint. Called on boot, on tab switch, and after every action. */
async function refresh() {
  const { view } = await loadView(db, cfg, now());
  paint(view);
  return view;
}

function selectTab(name) {
  tab = name;
  for (const [key, node] of Object.entries(els.views)) node.hidden = key !== name;
  for (const btn of els.tabs.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === name);
  }
  refresh();
}

/* ---------------- actions ---------------- */

const actions = {
  async complete(task) {
    const entry = { taskId: task.id };
    if (task.needsValue) {
      const value = await askValue(task);
      if (value === null) return;
      entry.value = value;
    } else if (task.pool) {
      const poolLabel = await askPool(task);
      if (poolLabel === null) return;
      entry.poolLabel = poolLabel;
    }

    const res = await completeTaskAction(db, cfg, now(), entry);
    if (!res.ok) {
      toast(res.reason === 'daily-cap' ? 'Daily cap reached for that one' : `Not recorded: ${res.reason}`, true);
      return void paint(viewOf(res.world, cfg, now()));
    }
    const points = res.completion.pointsAwarded;
    toast(points === null ? `${task.label} recorded — settles tonight` : `${task.label} · ${points > 0 ? `+${points}` : '0'} pts`);
    paint(viewOf(res.world, cfg, now()));
  },

  async spendSkip(group) {
    const [failureId] = group.ids; // rows in a group are interchangeable
    const res = await spendSkipAction(db, cfg, now(), failureId);
    if (!res.ok) {
      toast(res.reason === 'no-skips' ? 'No skips available' : `Cannot redeem: ${res.reason}`, true);
      return void paint(viewOf(res.world, cfg, now()));
    }
    toast(res.refunded > 0 ? `Skip spent · +${res.refunded} refunded` : 'Skip spent · refunded 0 (the floor had absorbed it)');
    paint(viewOf(res.world, cfg, now()));
  },

  async redeem(item) {
    const res = await redeemItemAction(db, cfg, now(), item.name);
    if (!res.ok) {
      toast(`Cannot redeem: ${res.reason.replace('-', ' ')}`, true);
      return void paint(viewOf(res.world, cfg, now()));
    }
    toast(`${item.name} redeemed · −${item.cost}`);
    paint(viewOf(res.world, cfg, now()));
  },

  async exportData() {
    const dump = await exportTracker(db, cfg, now());
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const file = `tracker-export-${new Date(now()).toISOString().slice(0, 10)}.json`;
    if (navigator.share && navigator.canShare?.({ files: [new File([blob], file)] })) {
      await navigator.share({ files: [new File([blob], file, { type: 'application/json' })], title: 'Tracker export' });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    URL.revokeObjectURL(url);
    toast('Export written');
  },
};

/* ---------------- boot ---------------- */

async function boot() {
  cfg = await loadConfig((...args) => fetch(...args));
  const opened = await openTracker(indexedDB, cfg, now());
  db = opened.db;

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) selectTab(btn.dataset.tab);
  });
  els.sheet.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) {
      els.sheet._cancel?.();
      closeSheet();
    }
  });
  // Reopening after the app was backgrounded settles any elapsed boundary.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  await refresh();
  els.boot.hidden = true;
  els.app.hidden = false;

  // Registered last, so a service-worker problem can never block the app.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('service worker not registered:', err.message);
    });
  }
}

boot().catch((err) => {
  els.boot.className = 'boot error';
  els.boot.textContent = `${err.name ?? 'Error'}\n\n${err.message}`;
  console.error(err);
});
