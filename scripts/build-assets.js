#!/usr/bin/env node
/**
 * build-assets.js — index assets/ so the app can show them offline.
 *
 *   npm run assets
 *
 * A static PWA cannot list a directory, so this writes assets/manifest.json
 * with the exact on-disk filenames, folds every asset into the service
 * worker's precache list, and bumps CACHE_VERSION when that list changes.
 *
 * CASE IS LOAD-BEARING. GitHub Pages serves case-sensitively while Windows
 * does not, so "IMG_1716.JPG" written as "img_1716.jpg" works locally and
 * 404s on the live site. Names are copied verbatim from readdir and never
 * normalised — not lowercased, not title-cased, not touched.
 *
 * Zero dependencies; Node's stdlib only.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const MANIFEST = path.join(ASSETS, 'manifest.json');
const SERVICE_WORKER = path.join(ROOT, 'service-worker.js');

/** Extensions every target browser can decode. */
const SUPPORTED = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
const LARGE_FILE_BYTES = 500 * 1024;
const SECTIONS = ['schedule', 'motivation'];

const problems = [];
const warnings = [];

/**
 * Files git ignores are never deployed, so indexing them would ship a manifest
 * and a precache list full of 404s. The manifest must describe what the LIVE
 * site serves, not what happens to sit on this machine — assets/motivation/ is
 * ignored precisely because those images stay off a public repo.
 */
function gitIgnoredPaths(candidates) {
  if (!candidates.length) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT,
      input: candidates.join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(out.split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean));
  } catch (err) {
    // Exit code 1 means "nothing ignored", which is not a failure. Anything
    // else (no git, not a repo) means we simply cannot tell — index everything.
    if (err.status === 1) return new Set();
    return new Set();
  }
}

function listSection(name) {
  const dir = path.join(ASSETS, name);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    if (name === 'schedule') problems.push(`assets/${name}/ does not exist`);
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Extension compared case-insensitively; the NAME is kept exactly as-is.
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED.includes(ext)) {
      warnings.push(
        `skipped assets/${name}/${entry.name} — ${ext || 'no extension'} is not a web image format` +
        (['.heic', '.heif'].includes(ext) ? '. Convert it to JPEG or PNG first (iOS: Share → Copy Photo, or export as JPEG).' : '.'),
      );
      continue;
    }
    const bytes = statSync(path.join(dir, entry.name)).size;
    if (bytes > LARGE_FILE_BYTES) {
      warnings.push(
        `assets/${name}/${entry.name} is ${(bytes / 1024).toFixed(0)}KB — over the ${LARGE_FILE_BYTES / 1024}KB ` +
        `guideline. It is precached for offline use, so a large image means a slower install and a bigger cache.`,
      );
    }
    files.push({ file: entry.name, path: `assets/${name}/${entry.name}`, bytes });
  }

  // Sorted by name so the manifest and the precache list are stable between
  // runs, which keeps CACHE_VERSION from bumping on filesystem ordering alone.
  files.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  return files;
}

const scanned = Object.fromEntries(SECTIONS.map((section) => [section, listSection(section)]));

const ignored = gitIgnoredPaths(
  SECTIONS.flatMap((section) => scanned[section]).map((asset) => asset.path),
);

const manifest = { generatedBy: 'npm run assets', sections: {} };
let total = 0;
let skippedForRepo = 0;
for (const section of SECTIONS) {
  const kept = scanned[section].filter((asset) => !ignored.has(asset.path));
  skippedForRepo += scanned[section].length - kept.length;
  manifest.sections[section] = kept;
  total += kept.length;
}
if (skippedForRepo) {
  warnings.push(
    `${skippedForRepo} image${skippedForRepo === 1 ? ' is' : 's are'} git-ignored and will not be ` +
    'deployed, so they are left out of the manifest and the precache list. They still show when ' +
    'you run the app from this machine.',
  );
}

if (manifest.sections.schedule.length === 0) {
  problems.push('assets/schedule/ has no deployable images — the Info tab needs at least one schedule image');
}

for (const warning of warnings) console.warn(`  warn  ${warning}`);

if (problems.length) {
  console.error('\nbuild-assets failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

/* ---------------- manifest ---------------- */

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

/* ---------------- service worker ---------------- */

const source = readFileSync(SERVICE_WORKER, 'utf8');

// Spaces and other unsafe characters must be percent-encoded for the cache to
// match what the page later requests.
const assetEntries = SECTIONS
  .flatMap((section) => manifest.sections[section])
  .map((asset) => `  './${encodeURI(asset.path)}',`);

const MARK_START = '  // --- generated by scripts/build-assets.js, do not edit by hand ---';
const MARK_END = '  // --- end generated ---';

const generatedBlock = [
  MARK_START,
  "  './assets/manifest.json',",
  ...assetEntries,
  MARK_END,
].join('\n');

let updated;
if (source.includes(MARK_START)) {
  updated = source.replace(
    new RegExp(`${MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    generatedBlock,
  );
} else {
  // First run: insert just before the closing bracket of the SHELL array.
  updated = source.replace(/(\nconst SHELL = \[[\s\S]*?)(\n\];)/, `$1\n${generatedBlock}$2`);
  if (updated === source) {
    console.error('build-assets failed: could not find the SHELL array in service-worker.js');
    process.exit(1);
  }
}

const shellOf = (text) => text.slice(text.indexOf('const SHELL = ['), text.indexOf('];', text.indexOf('const SHELL = [')));
const listChanged = shellOf(updated) !== shellOf(source);

const versionMatch = updated.match(/const CACHE_VERSION = (\d+);/);
if (!versionMatch) {
  console.error('build-assets failed: could not find CACHE_VERSION in service-worker.js');
  process.exit(1);
}
const currentVersion = Number(versionMatch[1]);
const nextVersion = listChanged ? currentVersion + 1 : currentVersion;
if (listChanged) {
  updated = updated.replace(/const CACHE_VERSION = \d+;/, `const CACHE_VERSION = ${nextVersion};`);
}

writeFileSync(SERVICE_WORKER, updated, 'utf8');

/* ---------------- report ---------------- */

console.log(`\nassets/manifest.json written — ${total} image${total === 1 ? '' : 's'}`);
for (const section of SECTIONS) {
  const files = manifest.sections[section];
  console.log(`  ${section.padEnd(11)}${files.length}${files.length ? `  (${files.map((f) => f.file).join(', ')})` : ''}`);
}
console.log(
  listChanged
    ? `  CACHE_VERSION  ${currentVersion} → ${nextVersion} (precache list changed)`
    : `  CACHE_VERSION  ${currentVersion} (precache list unchanged; bump by hand when app code changes)`,
);
console.log('');
