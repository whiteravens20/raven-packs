#!/usr/bin/env node
/**
 * Build one pack (or all packs) into every distribution format.
 *
 *   node scripts/build.mjs              # every pack under packs/
 *   node scripts/build.mjs ravenmc      # just this one
 *
 * Outputs, per pack, into dist/<slug>/:
 *
 *   manifest.json              Raven Forge manifest schema v2 — the URL players
 *                              paste into the launcher; sync is hash-verified.
 *   <slug>-<version>.mrpack    Modrinth pack — Prism, ATLauncher, MultiMC,
 *                              Modrinth App. Ships references, not jars.
 *   <slug>-<version>.zip       Plain mods/ + config/ tree to drop into an
 *                              existing .minecraft. No launcher required.
 *   pack.json / index.html     Machine- and human-readable pack metadata.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProject, resolveVersion, findMissingDependencies } from './lib/modrinth.mjs';
import { fetchFile, sha256, listFiles } from './lib/download.mjs';
import { ZipWriter } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'packs');
const DIST_DIR = path.join(ROOT, 'dist');

// ── Console helpers ────────────────────────────────────────

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const step = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

// ── Pack definition ────────────────────────────────────────

async function readPackDefinition(slug) {
  const file = path.join(PACKS_DIR, slug, 'pack.json');
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`No pack.json for "${slug}" (looked in ${path.relative(ROOT, file)})`);
  }

  const pack = JSON.parse(raw);

  const required = ['slug', 'name', 'version', 'minecraft', 'loader'];
  const missing = required.filter((key) => !pack[key]);
  if (missing.length > 0) {
    throw new Error(`${slug}/pack.json is missing: ${missing.join(', ')}`);
  }
  if (pack.slug !== slug) {
    throw new Error(`${slug}/pack.json declares slug "${pack.slug}" — must match its directory`);
  }

  pack.mods ??= [];
  pack.resourcePacks ??= [];
  pack.shaders ??= [];
  return pack;
}

// ── Resolution ─────────────────────────────────────────────

/**
 * Resolve every entry to a concrete file, downloading it so we can hash it.
 *
 * Entries are either Modrinth-backed (`slug`) or a direct URL (`url`), which is
 * how a pack ships something Modrinth does not host.
 */
async function resolveEntries(entries, pack, kind) {
  const loader = pack.loader.type;
  const resolved = [];

  for (const entry of entries) {
    if (entry.url) {
      const file = await fetchFile(entry.url);
      const filename = entry.filename ?? path.basename(new URL(entry.url).pathname);
      ok(`${entry.name ?? filename} ${file.cached ? '(cached)' : ''}`);
      resolved.push({
        kind,
        id: entry.id ?? filename.replace(/\.(jar|zip)$/i, ''),
        name: entry.name ?? filename,
        source: 'url',
        url: entry.url,
        filename,
        version: entry.version ?? 'unknown',
        file,
        project: { id: entry.id ?? entry.url, slug: entry.id ?? filename, license: 'unknown' },
        version_: { dependencies: [] },
      });
      continue;
    }

    if (!entry.slug) {
      throw new Error(`${kind} entry must have either "slug" (Modrinth) or "url": ${JSON.stringify(entry)}`);
    }

    const project = await getProject(entry.slug);
    const version = await resolveVersion(entry.slug, {
      mcVersion: pack.minecraft,
      loader,
      pin: entry.version,
      allowPrerelease: entry.allowPrerelease ?? false,
    });
    const file = await fetchFile(version.file.url, { sha1: version.file.sha1 });

    const notes = [
      entry.version ? 'pinned' : null,
      version.usedPrerelease ? `\x1b[33m${version.versionType}\x1b[0m` : null,
      file.cached ? 'cached' : null,
    ].filter(Boolean);

    ok(`${project.title} ${version.versionNumber}${notes.length ? ` (${notes.join(', ')})` : ''}`);

    // Client-side packs should not be shipping server-only mods.
    if (kind === 'mod' && project.clientSide === 'unsupported') {
      warn(`${project.title} is marked client-side: unsupported — it will do nothing for players`);
    }

    resolved.push({
      kind,
      id: project.slug,
      name: project.title,
      source: 'modrinth',
      projectId: project.id,
      versionId: version.versionId,
      url: version.file.url,
      filename: version.file.filename,
      version: version.versionNumber,
      file,
      project,
      version_: version,
    });
  }

  return resolved;
}

// ── Output: Raven Forge manifest (schema v2) ───────────────

function buildRavenForgeManifest(pack, mods, resourcePacks, shaders, configFiles) {
  const contentEntry = (item) => ({
    id: item.id,
    name: item.name,
    version: item.version,
    source: item.source,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    ...(item.source === 'url' ? { url: item.url } : {}),
    sha256: item.file.sha256,
  });

  return {
    manifestVersion: 2,
    serverName: pack.name,
    minecraftVersion: pack.minecraft,
    modLoader: pack.loader.type,
    modLoaderVersion: pack.loader.version,
    mods: mods.map((mod) => ({
      ...contentEntry(mod),
      required: true,
      side: 'client',
    })),
    resourcePacks: resourcePacks.map(contentEntry),
    shaders: shaders.map(contentEntry),
    configFiles,
  };
}

// ── Output: Modrinth .mrpack ───────────────────────────────

/**
 * Modrinth pack format v1: a zip holding `modrinth.index.json` plus an
 * `overrides/` tree. Files are referenced by URL, so the archive stays small and
 * the launcher fetches jars itself.
 * https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */
function buildMrpackIndex(pack, downloadables) {
  const loaderKey = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' }[
    pack.loader.type
  ];
  if (!loaderKey) throw new Error(`Loader "${pack.loader.type}" has no .mrpack dependency key`);

  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: pack.version,
    name: pack.name,
    summary: pack.summary ?? '',
    files: downloadables.map((item) => ({
      path: `${item.kind === 'mod' ? 'mods' : item.kind === 'shader' ? 'shaderpacks' : 'resourcepacks'}/${item.filename}`,
      hashes: { sha1: item.file.sha1, sha512: item.file.sha512 },
      env: { client: 'required', server: item.kind === 'mod' ? 'optional' : 'unsupported' },
      downloads: [item.url],
      fileSize: item.file.size,
    })),
    dependencies: {
      minecraft: pack.minecraft,
      [loaderKey]: pack.loader.version,
    },
  };
}

// ── Output: plain client zip ───────────────────────────────

function targetDir(kind) {
  return kind === 'mod' ? 'mods' : kind === 'shader' ? 'shaderpacks' : 'resourcepacks';
}

// ── Build one pack ─────────────────────────────────────────

async function buildPack(slug) {
  const pack = await readPackDefinition(slug);

  console.log(
    `\n\x1b[1m\x1b[36m${pack.name}\x1b[0m v${pack.version} — ` +
      `Minecraft ${pack.minecraft}, ${pack.loader.type} ${pack.loader.version}`,
  );

  step(`Resolving ${pack.mods.length} mods`);
  const mods = await resolveEntries(pack.mods, pack, 'mod');

  const resourcePacks = pack.resourcePacks.length
    ? (step(`Resolving ${pack.resourcePacks.length} resource packs`),
      await resolveEntries(pack.resourcePacks, pack, 'resourcepack'))
    : [];

  const shaders = pack.shaders.length
    ? (step(`Resolving ${pack.shaders.length} shaders`),
      await resolveEntries(pack.shaders, pack, 'shader'))
    : [];

  const all = [...mods, ...resourcePacks, ...shaders];

  step('Checking dependencies');
  const modrinthBacked = all.filter((item) => item.source === 'modrinth');
  const missing = await findMissingDependencies(
    modrinthBacked.map((item) => ({ project: item.project, version: item.version_ })),
  );
  if (missing.length > 0) {
    for (const dep of missing) {
      warn(`missing required dependency: ${dep.title} (${dep.slug}) — needed by ${dep.requiredBy.join(', ')}`);
    }
    throw new Error(
      `${missing.length} required dependencies are not in the pack. ` +
        `Add them to packs/${slug}/pack.json: ${missing.map((d) => `{ "slug": "${d.slug}" }`).join(', ')}`,
    );
  }
  ok('all required dependencies are present');

  // Overrides — config files and anything else dropped into the instance.
  const overridesDir = path.join(PACKS_DIR, slug, 'overrides');
  const overrides = await listFiles(overridesDir);
  if (overrides.length > 0) ok(`${overrides.length} override files`);

  const outDir = path.join(DIST_DIR, slug);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const overrideContents = await Promise.all(
    overrides.map(async (file) => ({ ...file, data: await fs.readFile(file.absolute) })),
  );

  step('Writing outputs');

  // 1. Raven Forge manifest. Overrides are published as `configFiles[]` served
  //    from the same release, so the launcher applies them on sync.
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

  const manifest = buildRavenForgeManifest(pack, mods, resourcePacks, shaders, configFiles);
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ok(`manifest.json (${manifest.mods.length} mods, ${configFiles.length} config files)`);

  // Overrides are also published as loose files so configFiles[] URLs resolve.
  for (const file of overrideContents) {
    const dest = path.join(outDir, 'overrides', file.relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.data);
  }

  // 2. Modrinth .mrpack
  const mrpack = new ZipWriter();
  mrpack.add('modrinth.index.json', JSON.stringify(buildMrpackIndex(pack, all), null, 2));
  for (const file of overrideContents) {
    mrpack.add(`overrides/${file.relative}`, file.data);
  }
  const mrpackName = `${slug}-${pack.version}.mrpack`;
  await fs.writeFile(path.join(outDir, mrpackName), mrpack.toBuffer());
  ok(`${mrpackName} (${mrpack.entryCount} entries)`);

  // 3. Plain client zip — jars included, ready to unzip into .minecraft
  const clientZip = new ZipWriter();
  for (const item of all) {
    clientZip.add(`${targetDir(item.kind)}/${item.filename}`, item.file.data, { store: true });
  }
  for (const file of overrideContents) {
    clientZip.add(file.relative, file.data);
  }
  clientZip.add('INSTALL.txt', clientInstructions(pack, all));
  const zipName = `${slug}-${pack.version}.zip`;
  const zipBuffer = clientZip.toBuffer();
  await fs.writeFile(path.join(outDir, zipName), zipBuffer);
  ok(`${zipName} (${clientZip.entryCount} entries, ${(zipBuffer.length / 1048576).toFixed(1)} MiB)`);

  // 4. Metadata for the landing page / launcher discovery
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
    counts: { mods: mods.length, resourcePacks: resourcePacks.length, shaders: shaders.length },
    mods: all.map((item) => ({
      id: item.id,
      name: item.name,
      version: item.version,
      license: item.project.license,
      url: item.projectId ? `https://modrinth.com/project/${item.id}` : item.url,
    })),
  };
  await fs.writeFile(path.join(outDir, 'pack.json'), JSON.stringify(meta, null, 2));
  ok('pack.json');

  return { pack, meta, outDir };
}

function clientInstructions(pack, items) {
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
    `Contents: ${items.length} files.`,
    '',
    'Every mod keeps its own license — see pack.json for the list.',
  ].join('\n');
}

// ── Entry point ────────────────────────────────────────────

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));

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
  for (const slug of slugs) {
    built.push(await buildPack(slug));
  }

  console.log(`\n\x1b[1m\x1b[32mBuilt ${built.length} pack(s)\x1b[0m → dist/`);
  for (const { meta, outDir } of built) {
    console.log(`  ${meta.name} ${meta.version} → ${path.relative(ROOT, outDir)}/`);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
