/**
 * app.js — entry point. Boots, settles, renders, and routes taps to actions.
 *
 * This is the only place that reads the clock or touches the DOM shell. It
 * owns no rules: reads go through rollover.js (which settles first and hands
 * back a view model), and every write goes through an action there, so every
 * user path runs rollover before it does anything else.
 */

import { loadConfig } from './config.js';
import { DB_NAME } from './db.js';
import {
  completeTaskAction,
  exportTracker,
  loadView,
  openTracker,
  readTrackerMeta,
  resetEverything,
  spendSkipAction,
  undoAction,
  viewOf,
} from './rollover.js';
import { celebrateTierUp, renderHeader, renderToday } from './ui/today.js';
import { renderSchedule } from './ui/schedule.js';
import { renderFailures } from './ui/failures.js';
import { initLightbox, renderInfo } from './ui/info.js';
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
  lightbox: document.getElementById('lightbox'),
  views: {
    today: document.getElementById('view-today'),
    schedule: document.getElementById('view-schedule'),
    failures: document.getElementById('view-failures'),
    info: document.getElementById('view-info'),
    history: document.getElementById('view-history'),
  },
};

let cfg = null;
let db = null;
let assets = { sections: { schedule: [], motivation: [] } };
let scheduleData = null;
let meta = { resetsUsed: 0 };
let scheduleOffset = 0;
let scheduleTimer = null;
let lastTierName = null;
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

/**
 * The reset confirmation.
 *
 * Gate one is the export, and it must COMPLETE — the typing field does not
 * appear until the download has actually been written, because "I meant to
 * back up first" is the regret this whole flow exists to prevent. Gate two is
 * typing RESET exactly; nothing matches it by accident.
 */
function confirmReset(summary) {
  return new Promise((resolve) => {
    els.sheetTitle.textContent = 'Reset the tracker?';

    const facts = document.createElement('div');
    facts.className = 'reset-facts';
    for (const [value, label] of [
      [`${summary.live}`, `completion${summary.live === 1 ? '' : 's'}`],
      [`${summary.failures}`, `failure${summary.failures === 1 ? '' : 's'}`],
      [`${summary.balance}`, 'points'],
      [`${summary.streak}`, 'day streak'],
    ]) {
      const cell = document.createElement('div');
      cell.className = 'reset-fact';
      const v = document.createElement('span');
      v.className = 'reset-fact-v';
      v.textContent = value;
      const k = document.createElement('span');
      k.className = 'reset-fact-k';
      k.textContent = label;
      cell.append(v, k);
      facts.append(cell);
    }

    const range = document.createElement('p');
    range.className = 'prose';
    range.textContent = summary.through
      ? `Recorded ${summary.since} to ${summary.through}. This is the only reset you get.`
      : 'There is nothing recorded yet. This is the only reset you get.';

    const step = document.createElement('p');
    step.className = 'reset-step';
    step.textContent = 'Step 1 of 2 — export a backup';

    const backup = document.createElement('button');
    backup.className = 'btn';
    backup.type = 'button';
    backup.textContent = 'Export a backup';

    const typed = document.createElement('div');
    typed.className = 'reset-typed';
    typed.hidden = true;
    const prompt = document.createElement('p');
    prompt.className = 'prose';
    prompt.textContent = 'Type RESET to confirm. This cannot be undone.';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'reset-input';
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'RESET';
    const erase = document.createElement('button');
    erase.className = 'btn btn-danger';
    erase.type = 'button';
    erase.textContent = 'Erase everything';
    erase.disabled = true;
    input.addEventListener('input', () => {
      erase.disabled = input.value.trim() !== 'RESET';
    });
    erase.addEventListener('click', () => {
      if (input.value.trim() !== 'RESET') return;
      closeSheet();
      resolve(true);
    });
    typed.append(prompt, input, erase);

    backup.addEventListener('click', async () => {
      backup.disabled = true;
      backup.textContent = 'Exporting…';
      let saved = false;
      try {
        saved = await actions.exportData();
      } catch (err) {
        toast(`Export failed: ${err.message}`, true);
      }
      if (!saved) {
        // No backup, no wipe. The gate stays shut.
        backup.disabled = false;
        backup.textContent = 'Export a backup';
        return;
      }
      backup.textContent = '✓ Backup exported';
      step.textContent = 'Step 2 of 2 — confirm';
      typed.hidden = false;
      input.focus();
    });

    els.sheetBody.replaceChildren(facts, range, step, backup, typed);
    els.sheet.hidden = false;
    els.sheet._cancel = () => resolve(false);
  });
}

/* ---------------- rendering ---------------- *//* ---------------- rendering ---------------- */

function paint(view) {
  renderHeader(els.header, view.header);
  if (tab === 'today') renderToday(els.views.today, view, actions);
  if (tab === 'schedule') renderSchedule(els.views.schedule, view, actions);
  if (tab === 'failures') renderFailures(els.views.failures, view, actions);
  if (tab === 'info') renderInfo(els.views.info, view, actions, assets);
  if (tab === 'history') renderHistory(els.views.history, view, actions);

  const open = view.failures.groups.reduce((sum, g) => sum + g.count, 0);
  els.badge.textContent = open;
  els.badge.hidden = open === 0;
}

const extras = () => ({ schedule: scheduleData, scheduleOffset, meta });

/** Settle and repaint. Called on boot, on tab switch, and after every action. */
async function refresh() {
  const { view } = await loadView(db, cfg, now(), extras());
  paint(view);
  return view;
}

/**
 * The Schedule tab is the one screen that goes stale just by sitting there,
 * so it re-evaluates on a timer while visible — and immediately whenever the
 * app comes back to the foreground, since a backgrounded timer is unreliable.
 */
function startScheduleTimer() {
  stopScheduleTimer();
  scheduleTimer = setInterval(() => {
    if (tab === 'schedule' && document.visibilityState === 'visible') refresh();
  }, 30000);
}

function stopScheduleTimer() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
}

function selectTab(name) {
  // Browsing other days is a detour, not a destination: the tab always
  // reopens on today.
  if (name === 'schedule' && tab !== 'schedule') scheduleOffset = 0;
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
      return void paint(viewOf(res.world, cfg, now(), extras()));
    }
    const points = res.completion.pointsAwarded;
    toast(points === null ? `${task.label} recorded — settles tonight` : `${task.label} · ${points > 0 ? `+${points}` : '0'} pts`);
    const view = viewOf(res.world, cfg, now(), extras());
    paint(view);
    // A tier-up earns a moment. The streak only moves at a day close, so this
    // fires on the first completion of a day that has already raised it.
    if (lastTierName && view.header.tierName !== lastTierName) {
      celebrateTierUp(els.header, view.header);
    }
    lastTierName = view.header.tierName;
  },

  scheduleStep(delta) {
    scheduleOffset = delta === 0 ? 0 : scheduleOffset + delta;
    refresh();
  },

  async undo(undoable) {
    const res = await undoAction(db, cfg, now(), undoable.id);
    if (!res.ok) {
      const why = {
        'no-undos-left': 'No undos left today',
        'day-closed': 'That day has already settled',
        'already-voided': 'Already undone',
      }[res.reason] ?? `Cannot undo: ${res.reason}`;
      toast(why, true);
      return void paint(viewOf(res.world, cfg, now(), extras()));
    }
    toast(res.refunded > 0
      ? `${undoable.label} undone · −${res.refunded}`
      : `${undoable.label} undone`);
    paint(viewOf(res.world, cfg, now(), extras()));
  },

  async spendSkip(group) {
    const [failureId] = group.ids; // rows in a group are interchangeable
    const res = await spendSkipAction(db, cfg, now(), failureId);
    if (!res.ok) {
      toast(res.reason === 'no-skips' ? 'No skips available' : `Cannot redeem: ${res.reason}`, true);
      return void paint(viewOf(res.world, cfg, now(), extras()));
    }
    toast(res.refunded > 0 ? `Skip spent · +${res.refunded} refunded` : 'Skip spent · refunded 0 (the floor had absorbed it)');
    paint(viewOf(res.world, cfg, now(), extras()));
  },

  /**
   * The single-use reset — the one named exception to never-delete.
   *
   * The allowance lives in the `meta` store, which the wipe recreates and
   * rewrites by hand: a counter stored inside the erased data would reset
   * itself, and "single use" would be a lie.
   */
  async resetAll(summary) {
    if (summary.resetsRemaining <= 0) {
      toast('The one reset has already been used', true);
      return;
    }
    if (!(await confirmReset(summary))) return;

    const res = await resetEverything(indexedDB, cfg, now(), { db });
    if (!res.ok) {
      toast(res.reason === 'no-resets-left' ? 'The one reset has already been used' : `Reset failed: ${res.reason}`, true);
      meta = res.meta ?? meta;
      return void refresh();
    }

    db = res.db;
    meta = res.meta;
    lastTierName = null;
    selectTab('today');
    toast('Everything erased — starting fresh');
  },

  /**
   * Write the export out.
   *
   * Resolves true when a file was genuinely produced, false when the user
   * backed out of the share sheet. That distinction matters: the reset gate
   * must only open on a real backup, and a cancelled share is a decision, not
   * a failure.
   *
   * iOS gets the share sheet; everything else gets a download. A share that
   * fails for any reason OTHER than the user cancelling falls through to the
   * download rather than leaving the user with no way to back up — which
   * would make the reset unreachable.
   */
  async exportData() {
    const dump = await exportTracker(db, cfg, now());
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const name = `tracker-export-${new Date(now()).toISOString().slice(0, 10)}.json`;

    if (navigator.share && navigator.canShare?.({ files: [new File([blob], name)] })) {
      try {
        await navigator.share({
          files: [new File([blob], name, { type: 'application/json' })],
          title: 'Tracker export',
        });
        toast('Export shared');
        return true;
      } catch (err) {
        if (err.name === 'AbortError') {
          toast('Export cancelled', true);
          return false;
        }
        // Share is unavailable for some other reason; the download still works.
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast('Export written');
    return true;
  },
};

/* ---------------- boot ---------------- */

/**
 * schedule.json gets the same treatment as config.json: fetched at runtime,
 * network-first in the service worker, nothing about it hardcoded.
 */
async function loadSchedule() {
  try {
    const res = await fetch('./schedule.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch {
    // Offline before it was ever cached.
  }
  return null;
}

/** The image index written by `npm run assets`. Absent is not an error. */
async function loadAssets() {
  try {
    const res = await fetch('./assets/manifest.json');
    if (!res.ok) return assets;
    const parsed = await res.json();
    if (parsed?.sections) return parsed;
  } catch {
    // Offline before the manifest was ever cached, or none generated yet.
  }
  return assets;
}

async function boot() {
  cfg = await loadConfig((...args) => fetch(...args));
  [assets, scheduleData] = await Promise.all([loadAssets(), loadSchedule()]);
  const opened = await openTracker(indexedDB, cfg, now());
  db = opened.db;
  meta = opened.meta ?? meta;

  initLightbox(els.lightbox);

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
  // Reopening after the app was backgrounded settles any elapsed boundary —
  // and re-dates the Schedule tab, whose "now" moved while we were away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('focus', () => refresh());
  startScheduleTimer();

  const view = await refresh();
  lastTierName = view.header.tierName;
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
