import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, StubElement } from './dom-stub.js';
import { cfg } from './helpers.js';
import { infoView } from '../js/views.js';

installDom();
const { renderInfo } = await import('../js/ui/info.js');

const view = { info: infoView(cfg) };

const makeAssets = (motivationCount, scheduleCount = 1) => ({
  sections: {
    schedule: Array.from({ length: scheduleCount }, (_, i) => ({
      file: `Schedule ${i + 1}.png`,
      path: `assets/schedule/Schedule ${i + 1}.png`,
      bytes: 1000,
    })),
    motivation: Array.from({ length: motivationCount }, (_, i) => ({
      file: `IMG_${i}.JPG`,
      path: `assets/motivation/IMG_${i}.JPG`,
      bytes: 2000,
    })),
  },
});

const render = (assets) => {
  const root = new StubElement('section');
  renderInfo(root, view, {}, assets);
  return root;
};

const headings = (root) => root.queryAll('.sec').map((n) => n.textContent);

test('Info renders with 0 motivation images — the section is absent, not empty', () => {
  const root = render(makeAssets(0));
  assert.equal(root.queryAll('.gallery-cell').length, 0);
  assert.equal(root.queryAll('.gallery').length, 0, 'no empty grid is left behind');
  assert.ok(!headings(root).includes('Motivation'), 'and no orphan heading');

  // The rest of the tab is unaffected.
  assert.equal(root.queryAll('.schedule-shot').length, 1);
  assert.ok(headings(root).includes('Every task'));
  assert.ok(headings(root).includes('How it works'));
});

test('Info renders with 1 motivation image', () => {
  const root = render(makeAssets(1));
  assert.ok(headings(root).includes('Motivation'));
  assert.equal(root.queryAll('.gallery').length, 1);
  assert.equal(root.queryAll('.gallery-cell').length, 1);
});

test('Info renders with 20 motivation images, all lazy below the fold', () => {
  const root = render(makeAssets(20));
  const cells = root.queryAll('.gallery-cell');
  assert.equal(cells.length, 20);

  const images = root.queryAll('IMG').filter((n) => n.src?.includes('motivation'));
  assert.equal(images.length, 20);
  assert.ok(images.every((img) => img.loading === 'lazy'), 'gallery images must lazy-load');
  assert.ok(images.every((img) => img.decoding === 'async'));
});

test('asset URLs are encoded, so spaces in filenames still resolve', () => {
  const root = render(makeAssets(0, 1));
  const [shot] = root.queryAll('.schedule-shot');
  const img = shot.children.find((c) => c.tagName === 'IMG');
  assert.equal(img.src, './assets/schedule/Schedule%201.png');
  assert.ok(!img.src.includes(' '), 'a raw space would 404 on the live site');
});

test('more than one schedule image stacks', () => {
  const root = render(makeAssets(0, 3));
  assert.equal(root.queryAll('.schedule-shot').length, 3);
});

test('a missing schedule explains itself rather than rendering nothing', () => {
  const root = render(makeAssets(4, 0));
  assert.equal(root.queryAll('.schedule-shot').length, 0);
  assert.match(root.textContent, /npm run assets/);
  assert.equal(root.queryAll('.gallery-cell').length, 4, 'the gallery still renders');
});

test('Info renders with no manifest at all', () => {
  const root = render(undefined);
  assert.equal(root.queryAll('.gallery-cell').length, 0);
  assert.ok(headings(root).includes('Every task'), 'the reference content does not depend on images');
});

test('the task table is built from config, with every task present', () => {
  const root = render(makeAssets(2));
  const rows = root.queryAll('.ref-row');
  assert.equal(rows.length, Object.keys(cfg.tasks).length);
  // Every row fits without a horizontal scroller: name, meta, stat strip.
  for (const row of rows) {
    assert.equal(row.queryAll('.ref-head').length, 1);
    assert.ok(row.queryAll('.ref-stat').length >= 3, 'points, penalty and target are always shown');
  }

  const text = root.textContent;
  for (const task of Object.values(cfg.tasks)) {
    assert.ok(text.includes(task.label), `${task.label} missing from the table`);
  }
  // Points and penalties come from config, not from anything hardcoded.
  assert.ok(text.includes(`+${cfg.tasks.certs.points}`));
  assert.ok(text.includes(`−${cfg.tasks.certs.penalty}`));
});

test('the explainer reads its numbers from config', () => {
  const root = render(makeAssets(0));
  const text = root.textContent;
  for (const tier of cfg.streak.tiers) {
    assert.ok(text.includes(tier.name), `${tier.name} missing`);
    assert.ok(text.includes(`${tier.multiplier}x`), `${tier.name} multiplier missing`);
  }
  assert.ok(text.includes(String(cfg.bonusWeeklyCap)), 'the weekly bonus cap');
  assert.ok(text.includes(String(cfg.skipsPerWeek)), 'the weekly skip grant');
  assert.ok(text.includes(String(cfg.undosPerDay)), 'the daily undo allowance');
  assert.ok(text.includes(String(cfg.balanceFloor)), 'the balance floor');
  assert.ok(text.includes(cfg.dayBoundary.timezone), 'the timezone');
});
