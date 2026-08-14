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
import { listFiles } from './lib/download.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'packs');

const LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const problems = [];
const fail = (slug, msg) => problems.push(`${slug}: ${msg}`);

/**
 * Check every resource pack and data pack we ship in the overrides.
 *
 * Minecraft gave pack formats a minor version and, at the same time, replaced
 * `pack_format`/`supported_formats` with `min_format`/`max_format`. A pack that
 * still uses the old keys *and* claims support past the changeover — resource
 * format 64, data format 81, both readable from
 * `PackFormat.lastPreMinorVersion` — fails to parse outright:
 *
 *   Pack declares support for version newer than 81, but is missing
 *   mandatory fields min_format and max_format
 *
 * Nothing downstream notices. The build succeeds, the sync succeeds, and the
 * player finds the pack greyed out as incompatible and dropped from the enabled
 * list — which is exactly how the guide book shipped broken once already.
 *
 * The right numbers for a given Minecraft version are not guessable; read them
 * from `version.json` in that version's client jar (`pack_version.resource_major`
 * for resource packs, `pack_version.data_major` for data packs).
 */
async function validatePackMeta(slug) {
  const metas = (await listFiles(path.join(PACKS_DIR, slug))).filter((f) =>
    f.relative.endsWith('pack.mcmeta'),
  );
  const before = problems.length;

  for (const file of metas) {
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(file.absolute, 'utf8'));
    } catch (err) {
      fail(slug, `${file.relative} is not valid JSON — ${err.message}`);
      continue;
    }

    const section = meta.pack ?? {};
    const legacy = ['pack_format', 'supported_formats'].filter((k) => k in section);
    if (legacy.length > 0) {
      fail(slug, `${file.relative} still uses ${legacy.join(' and ')} — replace with min_format/max_format`);
    }
    const missing = ['min_format', 'max_format'].filter((k) => !(k in section));
    if (missing.length > 0) {
      fail(slug, `${file.relative} is missing ${missing.join(' and ')} — the game cannot read its metadata`);
    }
  }

  if (metas.length > 0 && problems.length === before) {
    console.log(`  \x1b[32m✓\x1b[0m ${metas.length} pack.mcmeta declare min_format/max_format`);
  }
}

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

  await validatePackMeta(slug);

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

/**
 * Every JSON file under `site/` has to parse.
 *
 * These are hand-edited feeds that the launcher fetches at startup — the news
 * list and the announcement banner. Nothing else reads them on the way out:
 * `build.mjs` copies `site/` through verbatim, so a stray quote inside a
 * message reaches Pages intact and the launcher gets a body it cannot parse.
 *
 * That is exactly how a Polish closing quote typed as a plain `"` ended a
 * string early and published a broken announcement feed. One `JSON.parse` per
 * file closes it.
 */
async function validateSiteJson() {
  const SITE = path.join(ROOT, 'site');
  let checked = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // no site/ in this repo state
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith('.json')) {
        checked++;
        try {
          JSON.parse(await fs.readFile(full, 'utf8'));
        } catch (err) {
          fail('site', `${path.relative(ROOT, full)} is not valid JSON — ${err.message}`);
        }
      }
    }
  }

  await walk(SITE);
  const broken = problems.filter((p) => p.startsWith('site:')).length;
  if (broken) {
    console.log(`\n  \x1b[31m✗\x1b[0m ${broken} of ${checked} site JSON file(s) do not parse`);
  } else if (checked) {
    console.log(`\n  \x1b[32m✓\x1b[0m ${checked} site JSON file(s) parse`);
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
  await validateSiteJson();

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
