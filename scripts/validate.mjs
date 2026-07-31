#!/usr/bin/env node
/**
 * Validate pack definitions. Offline — no API calls, no downloads.
 *
 *   node scripts/validate.mjs [slug...]
 *
 * Checks structure, then that each pack's lockfile is present and agrees with
 * its definition. Runs on every pull request; a definition edited without
 * re-running `lock.mjs` fails here rather than silently shipping a stale mod
 * list.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLockfile, diffLockfile } from './lib/lockfile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'packs');

const LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const problems = [];
const fail = (slug, msg) => problems.push(`${slug}: ${msg}`);

async function validatePack(slug) {
  console.log(`\n\x1b[1m${slug}\x1b[0m`);

  const file = path.join(PACKS_DIR, slug, 'pack.json');
  let pack;
  try {
    pack = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    fail(slug, `pack.json is unreadable or not valid JSON — ${err.message}`);
    return;
  }

  for (const key of ['slug', 'name', 'version', 'minecraft', 'loader']) {
    if (!pack[key]) fail(slug, `missing required field "${key}"`);
  }
  if (pack.slug !== slug) fail(slug, `slug "${pack.slug}" does not match its directory`);
  if (pack.version && !SEMVER.test(pack.version)) {
    fail(slug, `version "${pack.version}" is not semver (e.g. 1.0.0)`);
  }
  if (pack.loader && !LOADERS.includes(pack.loader.type)) {
    fail(slug, `loader.type "${pack.loader?.type}" must be one of ${LOADERS.join(', ')}`);
  }
  if (pack.loader && !pack.loader.version) {
    fail(slug, 'loader.version is required — pin it so builds are reproducible');
  }
  if (problems.length > 0) return;

  const entries = [
    ...(pack.mods ?? []).map((e) => ['mod', e]),
    ...(pack.resourcePacks ?? []).map((e) => ['resourcePack', e]),
    ...(pack.shaders ?? []).map((e) => ['shader', e]),
  ];

  const seen = new Set();
  for (const [kind, entry] of entries) {
    const key = entry.slug ?? entry.url;
    if (!key) {
      fail(slug, `${kind} entry needs "slug" or "url": ${JSON.stringify(entry)}`);
      continue;
    }
    if (seen.has(key)) fail(slug, `${kind} "${key}" is listed twice`);
    seen.add(key);
  }

  console.log(`  ${entries.length} entries, Minecraft ${pack.minecraft}, ${pack.loader.type} ${pack.loader.version}`);

  const lock = await readLockfile(PACKS_DIR, slug);
  if (!lock) {
    fail(slug, `no pack.lock.json — run: node scripts/lock.mjs ${slug}`);
    console.log('  \x1b[31m✗\x1b[0m no lockfile');
    return;
  }

  const drift = diffLockfile(pack, lock);
  if (!drift.inSync) {
    for (const a of drift.added) console.log(`  \x1b[31m+\x1b[0m ${a.label} (${a.kind}) not in lockfile`);
    for (const r of drift.removed) console.log(`  \x1b[31m-\x1b[0m ${r.label} (${r.kind}) still in lockfile`);
    if (drift.packChanged) console.log('  \x1b[31m~\x1b[0m Minecraft/loader version changed');
    fail(slug, `pack.json and pack.lock.json disagree — run: node scripts/lock.mjs ${slug}`);
    return;
  }

  // Every locked file needs enough metadata for an offline build to emit both
  // the launcher manifest and the .mrpack.
  for (const file of lock.files) {
    const missing = ['url', 'fileName', 'size'].filter((k) => !file[k]);
    if (!file.sha512 && !file.sha256) missing.push('sha512/sha256');
    if (file.kind !== 'url' && !file.sha1 && file.source === 'modrinth') missing.push('sha1');
    if (missing.length > 0) fail(slug, `locked file "${file.id}" is missing: ${missing.join(', ')}`);
  }

  const prereleases = lock.files.filter((f) => /alpha|beta|snapshot|-rc/i.test(f.version));
  if (prereleases.length > 0) {
    console.log(`  \x1b[33m!\x1b[0m ${prereleases.length} prerelease version(s): ${prereleases.map((f) => f.id).join(', ')}`);
  }

  console.log(`  \x1b[32m✓\x1b[0m lockfile in sync — ${lock.files.length} files, locked ${lock.generatedAt.slice(0, 10)}`);
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const slugs = requested.length
    ? requested
    : (await fs.readdir(PACKS_DIR, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

  for (const slug of slugs) await validatePack(slug);

  if (problems.length > 0) {
    console.error(`\n\x1b[31m✗ ${problems.length} problem(s):\x1b[0m`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\n\x1b[32m✓ ${slugs.length} pack(s) valid\x1b[0m`);
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
