/**
 * ui/info.js — the reference tab: schedule, motivation gallery, task table,
 * and a short explainer of the rules.
 *
 * Denser and more visual than Today, because nothing here is tapped in a hurry.
 * Computes nothing: the task table and the rules come from `view.info` (derived
 * in views.js from config), and the images come from assets/manifest.json,
 * which scripts/build-assets.js writes. Adding an image and re-running
 * `npm run assets` is the whole workflow — no code knows any filename.
 */

import { clear, el, empty } from './dom.js';

/** Assets carry real on-disk names, spaces and all; the URL must be encoded. */
const assetUrl = (path) => `./${encodeURI(path)}`;

/* ---------------- lightbox ---------------- */

const lightbox = {
  root: null,
  img: null,
  caption: null,
  images: [],
  index: 0,
  scale: 1,
};

function renderLightbox() {
  const asset = lightbox.images[lightbox.index];
  if (!asset) return;
  lightbox.img.src = assetUrl(asset.path);
  lightbox.img.alt = asset.file;
  lightbox.scale = 1;
  lightbox.img.style.transform = '';
  lightbox.caption.textContent = lightbox.images.length > 1
    ? `${lightbox.index + 1} / ${lightbox.images.length}`
    : '';
}

function openLightbox(images, index) {
  lightbox.images = images;
  lightbox.index = index;
  renderLightbox();
  lightbox.root.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightbox.root.hidden = true;
  lightbox.img.removeAttribute('src');
  document.body.style.overflow = '';
}

function step(delta) {
  if (lightbox.images.length < 2) return;
  lightbox.index = (lightbox.index + delta + lightbox.images.length) % lightbox.images.length;
  renderLightbox();
}

/** Wired once, from app.js, against the markup in index.html. */
export function initLightbox(root) {
  lightbox.root = root;
  lightbox.img = root.querySelector('#lightbox-img');
  lightbox.caption = root.querySelector('#lightbox-caption');

  root.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeLightbox();
  });
  root.querySelector('[data-prev]').addEventListener('click', () => step(-1));
  root.querySelector('[data-next]').addEventListener('click', () => step(1));

  // Swipe between images; a short flick, not a drag threshold you have to hunt for.
  let startX = 0;
  let startY = 0;
  root.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (lightbox.scale > 1) return; // panning a zoomed image, not swiping
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  // Double-tap to zoom, since the app viewport suppresses page pinch-zoom.
  let lastTap = 0;
  lightbox.img.addEventListener('click', (e) => {
    const now = e.timeStamp;
    if (now - lastTap < 320) {
      lightbox.scale = lightbox.scale > 1 ? 1 : 2.5;
      const rect = lightbox.img.getBoundingClientRect();
      const originX = ((e.clientX - rect.left) / rect.width) * 100;
      const originY = ((e.clientY - rect.top) / rect.height) * 100;
      lightbox.img.style.transformOrigin = `${originX}% ${originY}%`;
      lightbox.img.style.transform = lightbox.scale > 1 ? `scale(${lightbox.scale})` : '';
    }
    lastTap = now;
  });

  document.addEventListener('keydown', (e) => {
    if (lightbox.root.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
}

/* ---------------- sections ---------------- */

function scheduleSection(images) {
  const wrap = el('div', 'schedule');
  images.forEach((asset, i) => {
    const button = el('button', 'schedule-shot');
    button.type = 'button';
    const img = document.createElement('img');
    img.src = assetUrl(asset.path);
    img.alt = 'Class schedule';
    img.decoding = 'async';
    button.append(img);
    button.addEventListener('click', () => openLightbox(images, i));
    wrap.append(button);
  });
  return wrap;
}

function gallerySection(images) {
  const grid = el('div', 'gallery');
  images.forEach((asset, i) => {
    const button = el('button', 'gallery-cell');
    button.type = 'button';
    const img = document.createElement('img');
    img.src = assetUrl(asset.path);
    img.alt = '';
    // Below the fold by definition; decoding a dozen at once stutters the
    // tab switch, and these are precached so laziness costs nothing offline.
    img.loading = 'lazy';
    img.decoding = 'async';
    button.append(img);
    button.addEventListener('click', () => openLightbox(images, i));
    grid.append(button);
  });
  return grid;
}

/** One stat in the strip under a task's name. */
function stat(label, value, tone) {
  const cell = el('div', 'ref-stat');
  const v = el('span', `ref-stat-v${tone ? ` ${tone}` : ''}`, value);
  cell.append(v, el('span', 'ref-stat-k', label));
  return cell;
}

/**
 * Rows, not a table. Five columns do not fit 390px, and a horizontally
 * scrolling table hides the two most useful numbers behind a gesture nobody
 * discovers — so each task gets a name line and a strip of stats beneath it.
 */
function taskTable(info) {
  const wrap = el('div', 'ref-list');

  for (const task of info.tasks) {
    const row = el('div', 'ref-row');

    const head = el('div', 'ref-head');
    head.append(el('span', 'ref-name', task.label));
    if (task.anchor) head.append(el('span', 'badge anchor', 'anchor'));
    row.append(head);
    row.append(el('div', 'ref-days', `${task.type} · ${task.typeBlurb} · ${task.days}`));

    const stats = el('div', 'ref-stats');
    stats.append(stat('points', `+${task.points}`, 'pos'));
    stats.append(stat('penalty', task.penalty ? `−${task.penalty}` : '—', task.penalty ? 'neg' : 'muted'));

    if (task.target) {
      const scope = task.target.scope === 'week' ? 'per week'
        : task.target.scope === 'day' ? 'per day'
          : 'daily cap';
      stats.append(stat(scope, String(task.target.value)));
    } else {
      stats.append(stat('target', '—', 'muted'));
    }

    if (task.targetBonus) stats.append(stat('at target', `+${task.targetBonus}`, 'pos'));
    if (task.extraEarnsPoints) stats.append(stat('past target', 'still pays', 'muted'));
    row.append(stats);
    wrap.append(row);
  }
  return wrap;
}

function rulesSection(info) {
  const { rules, tiers, anchors } = info;
  const wrap = el('div');

  const tierCard = el('div', 'card');
  tierCard.append(el('div', 'card-title', 'Streak multiplier'));
  tierCard.append(el('p', 'prose',
    'A day counts toward the streak when at least one anchor task is completed. '
    + 'The multiplier applies to points earned, never to penalties, and the tier in force is '
    + 'the one settled at the start of the day — reaching a new tier pays from tomorrow.'));
  const ladder = el('div', 'tier-ladder');
  for (const tier of tiers) {
    const step = el('div', `tier-step tier-${tier.name.toLowerCase()}`);
    step.append(el('span', 'tier-name', tier.name));
    step.append(el('span', 'tier-mult', `${tier.multiplier}x`));
    step.append(el('span', 'tier-at', `${tier.at} days`));
    ladder.append(step);
  }
  tierCard.append(ladder);
  wrap.append(tierCard);

  const anchorCard = el('div', 'card');
  anchorCard.append(el('div', 'card-title', 'Anchors'));
  anchorCard.append(el('p', 'prose',
    `${anchors.join(', ')} — completing any one of these keeps the streak alive for the day.`
    + (rules.bonusRequiresAnchor
      ? ' Until one lands, bonus tasks are still tappable but settle at 0 points that night.'
      : '')));
  wrap.append(anchorCard);

  const bonusCard = el('div', 'card');
  bonusCard.append(el('div', 'card-title', 'Bonus points'));
  bonusCard.append(el('p', 'prose',
    `Bonus taps are recorded straight away but scored at the ${rules.boundaryHour}:00 day close, `
    + 'once the anchor gate and the weekly cap are both known — so a chore done before the day’s '
    + `first anchor still pays in full. At most ${rules.bonusWeeklyCap} bonus points count per week.`));
  wrap.append(bonusCard);

  const skipCard = el('div', 'card');
  skipCard.append(el('div', 'card-title', 'Skips and undo'));
  skipCard.append(el('p', 'prose',
    `${rules.skipsPerWeek} skips arrive each week and ${rules.skipsRollOver ? 'roll over' : 'do not roll over'}; `
    + 'purchased ones never lapse. A skip clears one entry in the Failure log and refunds exactly what '
    + `that miss cost. Separately, ${rules.undosPerDay} undos a day take back a completion tapped by `
    + 'mistake — same day only, and the tap stays in the record either way.'));
  wrap.append(skipCard);

  const floorCard = el('div', 'card');
  floorCard.append(el('div', 'card-title', 'The floor'));
  floorCard.append(el('p', 'prose',
    `The balance can go negative, down to ${rules.balanceFloor}. Nothing is redeemable while it is below `
    + 'zero, and no debt is ever forgiven automatically. Days run '
    + `${rules.boundaryHour}:00 to ${rules.boundaryHour}:00, weeks from ${rules.weekStart}, `
    + `${rules.timezone}.`));
  wrap.append(floorCard);

  return wrap;
}

/* ---------------- the tab ---------------- */

export function renderInfo(root, view, actions, assets) {
  clear(root);
  const schedule = assets?.sections?.schedule ?? [];
  const motivation = assets?.sections?.motivation ?? [];

  root.append(el('h2', 'sec', 'Schedule'));
  if (schedule.length) root.append(scheduleSection(schedule));
  else root.append(empty('No schedule image yet. Drop one in assets/schedule/ and run npm run assets.'));

  // 0 images means the section is absent, not an empty box.
  if (motivation.length) {
    root.append(el('h2', 'sec', 'Motivation'));
    root.append(gallerySection(motivation));
  }

  root.append(el('h2', 'sec', 'Every task'));
  root.append(taskTable(view.info));

  root.append(el('h2', 'sec', 'How it works'));
  root.append(rulesSection(view.info));
}
