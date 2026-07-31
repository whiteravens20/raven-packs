#!/usr/bin/env node
/**
 * Build packs from their lockfiles into every distribution format.
 *
 *   node scripts/build.mjs                    # all packs, metadata only
 *   node scripts/build.mjs ravenmc            # one pack
 *   node scripts/build.mjs ravenmc --with-zip # also bundle the jars
 *
 * This script is **offline by default**. It reads `packs/<slug>/pack.lock.json`
 * — which already holds every URL, size and hash — and touches no API. Adding a
 * hundred mods therefore costs a hundred lines of lockfile and no build time.
 * Run `node scripts/lock.mjs` when the definition changes.
 *
 * Outputs, per pack, into dist/<slug>/:
 *
 *   manifest.json              Raven Forge manifest v2 — the URL players paste
 *                              into the launcher. Carries direct download URLs
 *                              and sha512, so the launcher resolves nothing.
 *   <slug>-<version>.mrpack    Modrinth pack — Prism, ATLauncher, MultiMC,
 *                              Modrinth App. References, not jars.
 *   <slug>-<version>.zip       Only with --with-zip. Real jars for a manual,
 *                              launcher-free install.
 *   pack.json                  Human-readable metadata and license list.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFile, sha256, listFiles } from './lib/download.mjs';
import { readLockfile, diffLockfile } from './lib/lockfile.mjs';
import { ZipWriter } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'packs');
const DIST_DIR = path.join(ROOT, 'dist');

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const step = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

const DIR_FOR_KIND = { mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks' };

// ── Output: Raven Forge manifest (schema v2) ───────────────

function buildRavenForgeManifest(pack, lock, configFiles) {
  const entry = (file) => ({
    id: file.id,
    name: file.name,
    version: file.version,
    source: file.source,
    ...(file.projectId ? { projectId: file.projectId } : {}),
    // The direct URL plus fileName means the launcher performs no API lookup at
    // sync time, and the pack keeps working even if Modrinth is unreachable.
    url: file.url,
    fileName: file.fileName,
    // sha512 comes straight from Modrinth; sha256 only exists for URL entries,
    // where we had to download the bytes anyway.
    ...(file.sha512 ? { sha512: file.sha512 } : {}),
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
  });

  const byKind = (kind) => lock.files.filter((f) => f.kind === kind);

  return {
    manifestVersion: 2,
    serverName: pack.name,
    minecraftVersion: pack.minecraft,
    modLoader: pack.loader.type,
    modLoaderVersion: pack.loader.version,
    mods: byKind('mod').map((file) => ({ ...entry(file), required: true, side: 'client' })),
    resourcePacks: byKind('resourcepack').map(entry),
    shaders: byKind('shader').map(entry),
    configFiles,
  };
}

// ── Output: Modrinth .mrpack ───────────────────────────────

/**
 * Modrinth pack format v1: a zip holding `modrinth.index.json` plus an
 * `overrides/` tree, referencing files by URL rather than embedding them.
 * https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */
function buildMrpackIndex(pack, lock) {
  const loaderKey = {
    fabric: 'fabric-loader',
    quilt: 'quilt-loader',
    forge: 'forge',
    neoforge: 'neoforge',
  }[pack.loader.type];
  if (!loaderKey) throw new Error(`Loader "${pack.loader.type}" has no .mrpack dependency key`);

  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: pack.version,
    name: pack.name,
    summary: pack.summary ?? '',
    files: lock.files.map((file) => ({
      path: `${DIR_FOR_KIND[file.kind]}/${file.fileName}`,
      hashes: { sha1: file.sha1, sha512: file.sha512 },
      env: { client: 'required', server: file.kind === 'mod' ? 'optional' : 'unsupported' },
      downloads: [file.url],
      fileSize: file.size,
    })),
    dependencies: {
      minecraft: pack.minecraft,
      [loaderKey]: pack.loader.version,
    },
  };
}

// ── Build one pack ─────────────────────────────────────────

async function buildPack(slug, { withZip }) {
  const packFile = path.join(PACKS_DIR, slug, 'pack.json');
  let pack;
  try {
    pack = JSON.parse(await fs.readFile(packFile, 'utf8'));
  } catch {
    throw new Error(`No pack.json for "${slug}"`);
  }

  const lock = await readLockfile(PACKS_DIR, slug);
  if (!lock) {
    throw new Error(`${slug} has no lockfile — run: node scripts/lock.mjs ${slug}`);
  }

  // A lockfile that no longer matches the definition would silently ship the
  // wrong mod list.
  const drift = diffLockfile(pack, lock);
  if (!drift.inSync) {
    for (const a of drift.added) console.log(`  \x1b[33m+ ${a.label} (${a.kind}) not in lockfile\x1b[0m`);
    for (const r of drift.removed) console.log(`  \x1b[33m- ${r.label} (${r.kind}) still in lockfile\x1b[0m`);
    if (drift.packChanged) console.log('  \x1b[33m~ Minecraft/loader version changed\x1b[0m');
    throw new Error(`${slug}: pack.json and pack.lock.json disagree — run: node scripts/lock.mjs ${slug}`);
  }
  if (lock.pack.version !== pack.version) {
    warn(`lockfile records pack version ${lock.pack.version}, definition says ${pack.version}`);
  }

  console.log(
    `\n\x1b[1m\x1b[36m${pack.name}\x1b[0m v${pack.version} — ` +
      `Minecraft ${pack.minecraft}, ${pack.loader.type} ${pack.loader.version}`,
  );

  const counts = {
    mod: lock.files.filter((f) => f.kind === 'mod').length,
    resourcepack: lock.files.filter((f) => f.kind === 'resourcepack').length,
    shader: lock.files.filter((f) => f.kind === 'shader').length,
  };
  ok(`${lock.files.length} locked files (${counts.mod} mods, ${counts.resourcepack} resource packs, ${counts.shader} shaders)`);

  const overridesDir = path.join(PACKS_DIR, slug, 'overrides');
  const overrides = await listFiles(overridesDir);
  const overrideContents = await Promise.all(
    overrides.map(async (file) => ({ ...file, data: await fs.readFile(file.absolute) })),
  );
  if (overrideContents.length > 0) ok(`${overrideContents.length} override files`);

  const outDir = path.join(DIST_DIR, slug);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  step('Writing outputs');

  // 1. Raven Forge manifest. Overrides publish as configFiles[] served from the
  //    same site, so the launcher applies them on sync.
  const baseUrl = (process.env.PACK_BASE_URL ?? '').replace(/\/$/, '');
  const configFiles = overrideContents.map((file) => ({
    path: file.relative,
    url: baseUrl
      ? `${baseUrl}/${slug}/overrides/${file.relative}`
      : `https://example.invalid/${slug}/overrides/${file.relative}`,
    sha256: sha256(file.data),
  }));
  if (overrideContents.length > 0 && !baseUrl) {
    warn('PACK_BASE_URL is unset — configFiles[] URLs are placeholders (CI sets this)');
  }

  const manifest = buildRavenForgeManifest(pack, lock, configFiles);
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ok(`manifest.json (${manifest.mods.length} mods, ${configFiles.length} config files)`);

  for (const file of overrideContents) {
    const dest = path.join(outDir, 'overrides', file.relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.data);
  }

  // 2. Modrinth .mrpack
  const mrpack = new ZipWriter();
  mrpack.add('modrinth.index.json', JSON.stringify(buildMrpackIndex(pack, lock), null, 2));
  for (const file of overrideContents) mrpack.add(`overrides/${file.relative}`, file.data);
  const mrpackName = `${slug}-${pack.version}.mrpack`;
  const mrpackBuffer = mrpack.toBuffer();
  await fs.writeFile(path.join(outDir, mrpackName), mrpackBuffer);
  ok(`${mrpackName} (${(mrpackBuffer.length / 1024).toFixed(1)} KiB)`);

  // 3. Plain client zip — the only output that needs the actual bytes, so it is
  //    opt-in. CI passes --with-zip for releases; local builds skip it.
  if (withZip) {
    step(`Downloading ${lock.files.length} files for the client zip`);
    const clientZip = new ZipWriter();
    let downloaded = 0;

    for (const file of lock.files) {
      const payload = await fetchFile(file.url, { sha1: file.sha1 });
      if (!payload.cached) downloaded++;
      clientZip.add(`${DIR_FOR_KIND[file.kind]}/${file.fileName}`, payload.data, { store: true });
    }
    ok(`${lock.files.length} files (${downloaded} downloaded, ${lock.files.length - downloaded} cached)`);

    for (const file of overrideContents) clientZip.add(file.relative, file.data);
    clientZip.add('INSTALL.txt', clientInstructions(pack, lock));

    const zipName = `${slug}-${pack.version}.zip`;
    const zipBuffer = clientZip.toBuffer();
    await fs.writeFile(path.join(outDir, zipName), zipBuffer);
    ok(`${zipName} (${clientZip.entryCount} entries, ${(zipBuffer.length / 1048576).toFixed(1)} MiB)`);
  } else {
    console.log('  \x1b[90m·\x1b[0m client zip skipped (pass --with-zip to bundle jars)');
  }

  // 4. Metadata for the landing page and for auditing licenses
  const meta = {
    slug: pack.slug,
    name: pack.name,
    version: pack.version,
    summary: pack.summary ?? '',
    minecraft: pack.minecraft,
    loader: pack.loader,
    recommendedRamMb: pack.recommendedRamMb ?? 4096,
    server: pack.server ?? null,
    builtAt: new Date().toISOString(),
    lockedAt: lock.generatedAt,
    counts: { mods: counts.mod, resourcePacks: counts.resourcepack, shaders: counts.shader },
    totalDownloadBytes: lock.files.reduce((sum, f) => sum + (f.size ?? 0), 0),
    mods: lock.files.map((file) => ({
      id: file.id,
      name: file.name,
      version: file.version,
      license: file.license,
      url: file.projectId ? `https://modrinth.com/project/${file.id}` : file.url,
    })),
  };
  await fs.writeFile(path.join(outDir, 'pack.json'), JSON.stringify(meta, null, 2));
  ok(`pack.json (${(meta.totalDownloadBytes / 1048576).toFixed(1)} MiB of mods)`);

  return { pack, meta, outDir };
}

function clientInstructions(pack, lock) {
  return [
    `${pack.name} ${pack.version}`,
    `Minecraft ${pack.minecraft} — ${pack.loader.type} ${pack.loader.version}`,
    '',
    'MANUAL INSTALL (no launcher required)',
    '',
    `1. Install the ${pack.loader.type} loader for Minecraft ${pack.minecraft}:`,
    pack.loader.type === 'fabric'
      ? '     https://fabricmc.net/use/installer'
      : '     https://quiltmc.org/en/install/',
    '2. Run the vanilla launcher once and pick the new profile, so the game',
    '   creates its folders. Then close the game.',
    '3. Copy the mods/ and config/ folders from this archive into your',
    '   .minecraft directory, merging with what is already there:',
    '     Windows  %APPDATA%\\.minecraft',
    '     Linux    ~/.minecraft',
    '     macOS    ~/Library/Application Support/minecraft',
    `4. Allocate at least ${pack.recommendedRamMb ?? 4096} MB of RAM to the profile.`,
    '',
    `Contents: ${lock.files.length} files.`,
    '',
    'Every mod keeps its own license — see pack.json for the list.',
  ].join('\n');
}

// ── Entry point ────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const withZip = args.includes('--with-zip');
  const requested = args.filter((a) => !a.startsWith('-'));

  const slugs = requested.length
    ? requested
    : (await fs.readdir(PACKS_DIR, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

  if (slugs.length === 0) {
    console.error('No packs found under packs/');
    process.exit(1);
  }

  const built = [];
  for (const slug of slugs) built.push(await buildPack(slug, { withZip }));

  console.log(`\n\x1b[1m\x1b[32mBuilt ${built.length} pack(s)\x1b[0m → dist/`);
  for (const { meta, outDir } of built) {
    console.log(`  ${meta.name} ${meta.version} → ${path.relative(ROOT, outDir)}/`);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
