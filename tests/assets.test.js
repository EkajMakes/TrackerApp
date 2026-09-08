import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url);
const root = (rel) => path.join(path.normalize(decodeURIComponent(new URL(rel, ROOT).pathname.replace(/^\//, ''))));

const manifest = JSON.parse(readFileSync(root('assets/manifest.json'), 'utf8'));
const serviceWorker = readFileSync(root('service-worker.js'), 'utf8');

const allAssets = Object.values(manifest.sections).flat();

test('every path in the manifest resolves to a real file with exact matching case', () => {
  assert.ok(allAssets.length > 0, 'the manifest should not be empty');

  for (const asset of allAssets) {
    const abs = root(asset.path);
    // existsSync is case-INSENSITIVE on Windows and would pass a wrong-case
    // path that 404s on GitHub Pages, so compare against the real directory
    // listing instead.
    const siblings = readdirSync(path.dirname(abs));
    const base = path.basename(abs);
    assert.ok(
      siblings.includes(base),
      `${asset.path} is not present with that exact casing (directory has: ${siblings.join(', ')})`,
    );
    assert.equal(asset.file, base, 'manifest file and path must agree');
    assert.equal(statSync(abs).size, asset.bytes, 'recorded size should match the file');
  }
});

test('the manifest never normalises case', () => {
  // Compared against the real directory listing rather than a lowercase
  // assumption: if the build script ever folds case, the name will not match
  // what the case-sensitive live site serves.
  for (const asset of allAssets) {
    const dir = path.dirname(root(asset.path));
    assert.ok(
      readdirSync(dir).includes(asset.file),
      `${asset.file} does not match the on-disk name exactly`,
    );
  }
});

test('git-ignored images are left out of the manifest entirely', () => {
  // assets/motivation/ is ignored so the photos stay off a public repo. The
  // manifest must describe what the DEPLOYED site serves, or the gallery would
  // request files that 404 in production while working fine locally.
  const ignoredDir = root('assets/motivation');
  let onDisk = [];
  try {
    onDisk = readdirSync(ignoredDir);
  } catch {
    onDisk = [];
  }
  if (!onDisk.length) return; // nothing local to be wrong about

  for (const asset of manifest.sections.motivation ?? []) {
    assert.fail(`${asset.path} is indexed but not deployable`);
  }
  for (const line of serviceWorker.split(/\r?\n/)) {
    assert.ok(!line.includes('assets/motivation/'), `precache references an undeployed image: ${line.trim()}`);
  }
});

test('a schedule image is required', () => {
  assert.ok(manifest.sections.schedule.length >= 1, 'the Info tab needs a schedule image');
});

test('the service worker precaches every asset, URL-encoded', () => {
  for (const asset of allAssets) {
    const entry = `'./${encodeURI(asset.path)}'`;
    assert.ok(
      serviceWorker.includes(entry),
      `${asset.path} is missing from the precache list (expected ${entry})`,
    );
  }
  assert.ok(serviceWorker.includes("'./assets/manifest.json'"), 'the manifest itself must be cached');
});

test('precached asset URLs contain no raw spaces', () => {
  const shell = serviceWorker.slice(
    serviceWorker.indexOf('const SHELL = ['),
    serviceWorker.indexOf('];', serviceWorker.indexOf('const SHELL = [')),
  );
  for (const line of shell.split('\n')) {
    const match = line.match(/'([^']+)'/);
    if (!match) continue;
    assert.ok(!/ /.test(match[1]), `precache entry has an unencoded space: ${match[1]}`);
  }
});

test('no precached asset is oversized', () => {
  // Matches the guideline the build script warns on; a hard assert here would
  // block a deliberate choice, so this only fails on the truly extreme.
  for (const asset of allAssets) {
    assert.ok(asset.bytes < 5 * 1024 * 1024, `${asset.path} is over 5MB and should not be precached`);
  }
});
