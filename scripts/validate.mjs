#!/usr/bin/env node
/**
 * Validate pack definitions without building them.
 *
 *   node scripts/validate.mjs [slug...]
 *
 * Cheap structural checks plus one API round trip per mod to confirm the pinned
 * version still exists. Runs on every pull request so a broken pack.json fails
 * before anyone waits on a full download.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProject, resolveVersion } from './lib/modrinth.mjs';

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

  for (const [kind, entry] of entries) {
    if (!entry.slug) continue;
    try {
      const project = await getProject(entry.slug);
      const version = await resolveVersion(entry.slug, {
        mcVersion: pack.minecraft,
        loader: pack.loader.type,
        pin: entry.version,
        allowPrerelease: entry.allowPrerelease ?? false,
      });
      const flag = version.usedPrerelease ? ` \x1b[33m[${version.versionType}]\x1b[0m` : '';
      console.log(`  \x1b[32m✓\x1b[0m ${project.title} → ${version.versionNumber}${flag}`);
    } catch (err) {
      console.log(`  \x1b[31m✗\x1b[0m ${entry.slug} — ${err.message}`);
      fail(slug, `${kind} "${entry.slug}": ${err.message}`);
    }
  }
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
