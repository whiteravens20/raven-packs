#!/usr/bin/env node
/**
 * Build packs from their lockfiles into every distribution format.
 *
 *   node scripts/build.mjs                    # all packs, metadata only
 *   node scripts/build.mjs ravenclassic            # one pack
 *   node scripts/build.mjs ravenclassic --with-zip # also bundle the jars
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
 *
 * Plus one file for the whole site:
 *
 *   packs.json                 Catalogue of every pack in dist/ — what the
 *                              launcher fetches to offer a choice.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchFile, sha1, sha256, listFiles } from './lib/download.mjs';
import { readLockfile, diffLockfile } from './lib/lockfile.mjs';
import { ZipWriter } from './lib/zip.mjs';
import { buildServersDat, serverAddress } from './lib/servers-dat.mjs';
import { isCopyleft } from './lib/licences.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'packs');
const DIST_DIR = path.join(ROOT, 'dist');
const SITE_DIR = path.join(ROOT, 'site');

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const step = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

const DIR_FOR_KIND = { mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks' };

const forClient = (file) => file.side === 'client' || file.side === 'both';
const forServer = (file) => file.side === 'server' || file.side === 'both';

/**
 * CRLF for files Windows reads.
 *
 * `cmd.exe` is unreliable with LF-only batch files — labels and multi-line
 * blocks can misparse — and Notepad only learned to render lone LF in Windows
 * 10 1809. Both are cheap to avoid.
 */
const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

// ── Summaries, in more than one language ───────────────────

/**
 * A pack's summary in every language it was written in.
 *
 * `pack.json` takes either a plain string or a `{ locale: text }` map. The map
 * is why this exists: the launcher renders the pack list in the language the
 * player chose, and the one line describing each pack should not be the part
 * that ignores the setting.
 *
 * Everything downstream is handed a map, so there is one shape to handle. A
 * bare string is read as English — a summary written without naming a language
 * is the one that travels, and it is the .mrpack that carries it to Prism and
 * the Modrinth app.
 */
function summaryMap(summary) {
  if (!summary) return {};
  if (typeof summary === 'string') return { en: summary };
  return Object.fromEntries(
    Object.entries(summary).filter(([, text]) => typeof text === 'string' && text.trim() !== ''),
  );
}

/**
 * One language out of that map, for a consumer that can hold only a string.
 *
 * Falls through to English and then to whatever exists, rather than returning
 * nothing: a summary in the wrong language still says what the pack is, and an
 * empty one says nothing at all.
 */
function summaryIn(summary, locale) {
  const map = summaryMap(summary);
  return map[locale] ?? map.en ?? Object.values(map)[0] ?? '';
}

/**
 * The language a launcher too old to know `summaryI18n` will show.
 *
 * Those launchers read the flat `summary` and nothing else. Changing this
 * constant changes what they display without anyone updating anything, so it
 * tracks who is actually running them rather than what reads best to us.
 */
const LEGACY_SUMMARY_LOCALE = 'pl';

/**
 * Collect override files for one side.
 *
 * Mirrors the .mrpack layout: `overrides/` applies to both, `client-overrides/`
 * and `server-overrides/` to one each. Keeping them separate is what stops a
 * client download from carrying `server.properties` or an operator list.
 */
async function readOverrides(slug, side) {
  const dirs = ['overrides', side === 'client' ? 'client-overrides' : 'server-overrides'];
  const files = [];

  for (const dir of dirs) {
    const found = await listFiles(path.join(PACKS_DIR, slug, dir));
    for (const file of found) {
      files.push({ ...file, data: await fs.readFile(file.absolute) });
    }
  }
  return files;
}

// ── Output: the resource pack the server pushes ────────────

const SERVER_RESOURCE_PACK_DIR = 'server-resourcepack';

/**
 * A fixed timestamp for the server resource pack's zip entries.
 *
 * The archive is hashed and the hash is written into `server.properties`, so
 * two builds of the same commit have to produce the same bytes — otherwise the
 * pack published with one release and the hash shipped in another disagree.
 * Local date parts (not UTC) because `dosDateTime` reads local ones, which is
 * what keeps the result identical in every timezone.
 */
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

/**
 * Zip `packs/<slug>/server-resourcepack/` — the client-side text that belongs
 * to the server, delivered by the server.
 *
 * The guide book is a datapack: the server owns it and syncs it to whoever
 * joins. Its *text* is a resource pack, and a resource pack can only come from
 * the client side — so shipping it as a launcher override meant it existed only
 * for players who arrived through Raven Forge, and only until something
 * rewrote `options.txt`. Everyone else read the book as raw translation keys.
 *
 * Handing it to the server closes both holes at once. `require-resource-pack`
 * makes it a condition of joining, so there is no client on the server without
 * the text, whichever launcher it came from; and the pack ships from the same
 * build as the book it describes, so the two cannot drift.
 *
 * Entries are stored rather than deflated. The payload is a few kilobytes of
 * JSON, and deflate output is only stable for a given zlib build — which is a
 * silly thing to make the hash depend on.
 */
async function buildServerResourcePack(slug, pack) {
  const dir = path.join(PACKS_DIR, slug, SERVER_RESOURCE_PACK_DIR);
  const files = await listFiles(dir);
  if (files.length === 0) return null;

  if (!files.some((file) => file.relative === 'pack.mcmeta')) {
    throw new Error(
      `${slug}: ${SERVER_RESOURCE_PACK_DIR}/ has no pack.mcmeta — Minecraft would reject the pack and every player with it.`,
    );
  }

  const zip = new ZipWriter();
  for (const file of files) {
    zip.add(file.relative, await fs.readFile(file.absolute), { store: true, mtime: ZIP_EPOCH });
  }
  const data = zip.toBuffer();

  // Release asset, not the Pages copy, and that is the point: release assets
  // are immutable, so a server still running an older pack keeps serving the
  // exact file its own server.properties was built against. A Pages URL would
  // have the next release rewrite the bytes under every running server, and a
  // hash that no longer matches locks every player out of one that requires it.
  const fileName = `${slug}-resources-${pack.version}.zip`;
  const releaseBase = (process.env.PACK_RELEASE_BASE_URL ?? '').replace(/\/$/, '');
  if (!releaseBase) {
    warn(
      'PACK_RELEASE_BASE_URL is unset — server.properties gets a placeholder resource-pack URL (CI sets this). ' +
        'A server started from this build would reject every player.',
    );
  }
  const base = releaseBase || 'https://example.invalid/releases/download';

  return {
    fileName,
    data,
    url: `${base}/${slug}-v${pack.version}/${fileName}`,
    sha1: sha1(data),
    // Derived from the slug, so it is the pack's identity rather than this
    // version's: the client sees an update to a pack it knows instead of an
    // unrelated one, every time the URL changes.
    id: uuidFromName(`raven-packs:${slug}:${SERVER_RESOURCE_PACK_DIR}`),
    prompt: `${pack.name} — teksty przewodnika po serwerze.`,
  };
}

/** RFC 4122 name-based UUID (version 5), which is what Minecraft expects here. */
function uuidFromName(name) {
  const bytes = createHash('sha1').update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Keys in `server.properties` that the build owns.
 *
 * Anything an author wrote for these is dropped rather than merged. The URL,
 * the hash and the pack's id all describe the archive that was just built, and
 * a hand-written hash that disagrees with it does not fail a build — it fails
 * every player's login, on a server that by then is already live.
 */
const GENERATED_SERVER_PROPERTIES = [
  'resource-pack',
  'resource-pack-sha1',
  'resource-pack-hash',
  'resource-pack-id',
  'resource-pack-prompt',
  'require-resource-pack',
];

function serverPropertiesWith(authored, resourcePack) {
  const lines = authored
    .split(/\r?\n/)
    .filter((line) => !GENERATED_SERVER_PROPERTIES.includes(line.split('=')[0].trim()));

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  return [
    ...lines,
    '',
    '# Written by scripts/build.mjs. Edits below are replaced on every build.',
    '#',
    '# The pack carries the guide book text. The server hands it out instead of',
    '# the launcher installing it, so that it reaches every client whatever',
    '# launcher it arrived from, and so it can never fall out of step with the',
    '# book the datapack defines. Requiring it is what makes that a guarantee.',
    `resource-pack=${resourcePack.url}`,
    `resource-pack-sha1=${resourcePack.sha1}`,
    `resource-pack-id=${resourcePack.id}`,
    // A chat component, parsed as JSON. Read back through java.util.Properties,
    // so the text must carry no backslash and no quote of its own.
    `resource-pack-prompt=${JSON.stringify({ text: resourcePack.prompt })}`,
    'require-resource-pack=true',
    '',
  ].join('\n');
}

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

  // Only client-relevant content reaches the manifest. The launcher would skip
  // `side: "server"` entries anyway, but shipping them would mean every player
  // downloads a mod list describing files they must never install.
  const byKind = (kind) => lock.files.filter((f) => f.kind === kind && forClient(f));

  return {
    manifestVersion: 2,
    serverName: pack.name,
    minecraftVersion: pack.minecraft,
    modLoader: pack.loader.type,
    modLoaderVersion: pack.loader.version,
    // Carried in the manifest and not only in packs.json, so a player who pastes
    // the manifest URL gets the same RAM the catalogue would have given them.
    // Omitted rather than defaulted: a pack with no opinion should leave the
    // launcher's own default alone.
    ...(pack.recommendedRamMb ? { recommendedRamMb: pack.recommendedRamMb } : {}),
    mods: byKind('mod').map((file) => ({
      ...entry(file),
      required: true,
      // `both` is preserved so the launcher and the player can see that the
      // server runs it too; only `server` is filtered out entirely.
      side: file.side === 'both' ? 'both' : 'client',
    })),
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
    // Modrinth's format has one summary field and no language beside it, and
    // this file is read by Prism, ATLauncher and the Modrinth app rather than
    // by us. English is the language that reaches most of them.
    summary: summaryIn(pack.summary, 'en'),
    // `env` carries the real side, so an importing launcher installs a
    // server-only mod only when creating a server instance.
    files: lock.files.map((file) => ({
      path: `${DIR_FOR_KIND[file.kind]}/${file.fileName}`,
      hashes: { sha1: file.sha1, sha512: file.sha512 },
      env: {
        client: forClient(file) ? 'required' : 'unsupported',
        server: forServer(file) ? 'required' : 'unsupported',
      },
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

  const clientFiles = lock.files.filter(forClient);
  const serverFiles = lock.files.filter(forServer);
  ok(`client pack: ${clientFiles.length} files · server pack: ${serverFiles.length} files`);

  const overrideContents = await readOverrides(slug, 'client');
  const serverOverrides = await readOverrides(slug, 'server');

  // Put the pack's own server in the multiplayer list, so a new install has it
  // without anyone typing an address. Generated rather than committed: the
  // address lives in pack.json and nowhere else, and a checked-in binary would
  // be free to drift from it with nothing to catch the difference.
  if (pack.server?.ip) {
    const address = serverAddress(pack.server);
    overrideContents.push({
      relative: 'servers.dat',
      data: buildServersDat([{ name: pack.serverListName ?? pack.name, ip: address }]),
    });
    ok(`servers.dat — ${address}`);
  }

  if (overrideContents.length > 0) ok(`${overrideContents.length} client override files`);
  if (serverOverrides.length > 0) ok(`${serverOverrides.length} server override files`);

  const serverResourcePack = await buildServerResourcePack(slug, pack);

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

  // 1b. The server's resource pack. It goes into dist/ so the release picks it
  //     up as an asset — that URL is what server.properties points at.
  if (serverResourcePack) {
    await fs.writeFile(path.join(outDir, serverResourcePack.fileName), serverResourcePack.data);
    ok(
      `${serverResourcePack.fileName} (${(serverResourcePack.data.length / 1024).toFixed(1)} KiB, sha1 ${serverResourcePack.sha1.slice(0, 12)}…)`,
    );
  }

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

  // 3. Bundled zips — the only outputs needing the actual bytes, so they are
  //    opt-in. CI passes --with-zip for releases; local builds skip them.
  if (withZip) {
    step(`Downloading jars for the bundled zips`);
    const payloads = new Map();
    let downloaded = 0;

    for (const file of lock.files) {
      const payload = await fetchFile(file.url, { sha1: file.sha1 });
      if (!payload.cached) downloaded++;
      payloads.set(file.id, payload);
    }
    ok(`${lock.files.length} files (${downloaded} downloaded, ${lock.files.length - downloaded} cached)`);

    // Client zip — client + both, client overrides only.
    const clientZip = new ZipWriter();
    for (const file of clientFiles) {
      clientZip.add(`${DIR_FOR_KIND[file.kind]}/${file.fileName}`, payloads.get(file.id).data, { store: true });
    }
    for (const file of overrideContents) clientZip.add(file.relative, file.data);
    // Most players opening this are on Windows, reading it in Notepad.
    clientZip.add('INSTALL.txt', crlf(clientInstructions(pack, clientFiles)));
    clientZip.add('LICENSES.txt', crlf(licenceNotice(pack, clientFiles)));

    const zipName = `${slug}-${pack.version}.zip`;
    const zipBuffer = clientZip.toBuffer();
    await fs.writeFile(path.join(outDir, zipName), zipBuffer);
    ok(`${zipName} (${clientZip.entryCount} entries, ${(zipBuffer.length / 1048576).toFixed(1)} MiB)`);

    // Server zip — server + both, server overrides, plus start scripts and the
    // Fabric server launcher so an admin can unzip and run.
    if (serverFiles.length > 0) {
      const serverZip = new ZipWriter();
      for (const file of serverFiles) {
        if (file.kind !== 'mod') continue; // shaders/resource packs are client-only
        serverZip.add(`mods/${file.fileName}`, payloads.get(file.id).data, { store: true });
      }
      // server.properties is authored by hand but finished here: the pack's
      // URL and hash only exist once it has been built.
      const authoredProperties = serverOverrides.find((f) => f.relative === 'server.properties');
      if (serverResourcePack && !authoredProperties) {
        throw new Error(
          `${slug}: ${SERVER_RESOURCE_PACK_DIR}/ exists but server-overrides/server.properties does not — nothing would tell the server to hand the pack out.`,
        );
      }

      for (const file of serverOverrides) {
        const data =
          serverResourcePack && file === authoredProperties
            ? serverPropertiesWith(file.data.toString('utf8'), serverResourcePack)
            : file.data;
        serverZip.add(file.relative, data);
      }
      if (serverResourcePack) {
        ok(`server.properties requires ${serverResourcePack.fileName} from the release`);
      }

      const launcher = lock.pack.serverLauncher;
      if (launcher) {
        const jar = await fetchFile(launcher.url);
        serverZip.add(launcher.fileName, jar.data, { store: true });
        ok(
          `bundled ${launcher.fileName} (${pack.loader.type} ${launcher.kind === 'installer' ? 'installer' : `installer ${launcher.installerVersion}`})`,
        );
      } else {
        warn(`no server launcher for loader "${pack.loader.type}" — admins must install it manually`);
      }

      const requiredJava = lock.pack.requiredJava;
      // 0o755 so an admin can run ./start.sh straight out of the archive.
      serverZip.add('start.sh', startScriptUnix(pack, launcher, requiredJava), { mode: 0o755 });
      serverZip.add('start.bat', crlf(startScriptWindows(pack, launcher, requiredJava)));
      serverZip.add('SERVER-INSTALL.txt', crlf(serverInstructions(pack, serverFiles, launcher, requiredJava)));
      serverZip.add('LICENSES.txt', crlf(licenceNotice(pack, serverFiles)));

      const serverZipName = `${slug}-${pack.version}-server.zip`;
      const serverBuffer = serverZip.toBuffer();
      await fs.writeFile(path.join(outDir, serverZipName), serverBuffer);
      ok(`${serverZipName} (${serverZip.entryCount} entries, ${(serverBuffer.length / 1048576).toFixed(1)} MiB)`);
    } else {
      console.log('  \x1b[90m·\x1b[0m no server-side mods — server zip not built');
    }
  } else {
    console.log('  \x1b[90m·\x1b[0m zips skipped (pass --with-zip to bundle jars)');
  }

  // 4. Metadata for the landing page and for auditing licenses
  const meta = {
    slug: pack.slug,
    name: pack.name,
    version: pack.version,
    summary: summaryIn(pack.summary, LEGACY_SUMMARY_LOCALE),
    summaryI18n: summaryMap(pack.summary),
    minecraft: pack.minecraft,
    loader: pack.loader,
    recommendedRamMb: pack.recommendedRamMb ?? 4096,
    server: pack.server ?? null,
    builtAt: new Date().toISOString(),
    lockedAt: lock.generatedAt,
    counts: {
      mods: counts.mod,
      resourcePacks: counts.resourcepack,
      shaders: counts.shader,
      client: clientFiles.length,
      server: serverFiles.length,
    },
    totalDownloadBytes: clientFiles.reduce((sum, f) => sum + (f.size ?? 0), 0),
    serverDownloadBytes: serverFiles.reduce((sum, f) => sum + (f.size ?? 0), 0),
    mods: lock.files.map((file) => ({
      id: file.id,
      name: file.name,
      version: file.version,
      side: file.side,
      license: file.license,
      url: file.projectId ? `https://modrinth.com/project/${file.id}` : file.url,
    })),
  };
  await fs.writeFile(path.join(outDir, 'pack.json'), JSON.stringify(meta, null, 2));
  ok(`pack.json (${(meta.totalDownloadBytes / 1048576).toFixed(1)} MiB of mods)`);

  return { pack, meta, outDir };
}

// ── Server pack extras ─────────────────────────────────────

/**
 * Server RAM: more than the client, but capped well below "all of it".
 * Large heaps mean longer garbage-collection pauses, which players feel as lag
 * spikes far more than they feel a smaller cache.
 */
function serverRamMb(pack) {
  return Math.min(Math.max(pack.recommendedRamMb ?? 4096, 4096), 8192);
}

/**
 * The EULA is deliberately not pre-accepted — that is the operator's legal
 * agreement with Mojang to make, not something a build script forges. The
 * scripts detect the first-run state and say exactly what to do.
 */
function startScriptUnix(pack, launcher, requiredJava) {
  const ram = serverRamMb(pack);
  const jar = launcher?.fileName ?? 'server.jar';

  // Check Java *before* launching. Without this an admin on an older JDK gets
  // an UnsupportedClassVersionError stack trace out of Fabric's bootstrap,
  // which says nothing about what to actually install.
  const javaCheck = requiredJava
    ? `
REQUIRED_JAVA=${requiredJava}
if ! command -v java >/dev/null 2>&1; then
  echo "Java is not installed or not on PATH. This pack needs Java $REQUIRED_JAVA." >&2
  exit 1
fi

# "1.8.0_411" -> 8, "25.0.1" -> 25
JAVA_RAW=$(java -version 2>&1 | head -n1 | sed 's/.*version "\\([^"]*\\)".*/\\1/')
JAVA_MAJOR=$(echo "$JAVA_RAW" | awk -F'[."]' '/^1\\./ {print $2; exit} {print $1; exit}')

if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt "$REQUIRED_JAVA" ]; then
  echo "Minecraft ${pack.minecraft} needs Java $REQUIRED_JAVA, but 'java' is version $JAVA_RAW." >&2
  echo "Install a newer JDK (https://adoptium.net/) or point JAVA_HOME at one." >&2
  exit 1
fi
`
    : '';

  // NeoForge ships an installer, not a runnable jar. It has to be run once
  // against this directory; afterwards the server starts from the args file the
  // installer wrote, and the jar is never executed again. Doing it inside the
  // start script keeps the server pack turnkey, which is the whole point.
  const neoInstall =
    launcher?.kind === 'installer'
      ? `
if [ ! -f "${launcher.argsFile}" ]; then
  echo "First run: installing ${pack.loader.type} ${pack.loader.version}…"
  java -jar "${jar}" --install-server . || {
    echo "The ${pack.loader.type} installer failed. See the output above." >&2
    exit 1
  }
fi
`
      : '';

  const launch =
    launcher?.kind === 'installer'
      ? `exec java -Xms${Math.min(ram, 2048)}M -Xmx${ram}M \\
  -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \\
  @"${launcher.argsFile}" nogui`
      : `exec java -Xms${Math.min(ram, 2048)}M -Xmx${ram}M \\
  -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \\
  -jar "${jar}" nogui`;

  return `#!/usr/bin/env sh
# ${pack.name} ${pack.version} — Minecraft ${pack.minecraft}, ${pack.loader.type} ${pack.loader.version}
set -e
cd "$(dirname "$0")"

if [ ! -f "${jar}" ]; then
  echo "Missing ${jar} — re-extract the server pack." >&2
  exit 1
fi
${javaCheck}
if [ ! -f eula.txt ]; then
  echo "First run: accept the Minecraft EULA."
  echo "  https://aka.ms/MinecraftEULA"
  echo "Then create eula.txt containing:  eula=true"
  exit 1
fi

${neoInstall}
${launch}
`;
}

function startScriptWindows(pack, launcher, requiredJava) {
  const ram = serverRamMb(pack);
  const jar = launcher?.fileName ?? 'server.jar';

  const javaCheck = requiredJava
    ? `
where java >nul 2>&1
if errorlevel 1 (
  echo Java is not installed or not on PATH. This pack needs Java ${requiredJava}.
  pause
  exit /b 1
)
`
    : '';

  // Same installer dance as the shell script; see the comment there.
  const neoInstall =
    launcher?.kind === 'installer'
      ? `
if not exist "${launcher.argsFileWindows}" (
  echo First run: installing ${pack.loader.type} ${pack.loader.version}...
  java -jar "${jar}" --install-server .
  if errorlevel 1 (
    echo The ${pack.loader.type} installer failed. See the output above.
    pause
    exit /b 1
  )
)

`
      : '';

  const launchArgs =
    launcher?.kind === 'installer' ? `@"${launcher.argsFileWindows}"` : `-jar "${jar}"`;

  return `@echo off
REM ${pack.name} ${pack.version} — Minecraft ${pack.minecraft}, ${pack.loader.type} ${pack.loader.version}
REM Requires Java ${requiredJava ?? '17 or newer'}.
cd /d "%~dp0"

if not exist "${jar}" (
  echo Missing ${jar} - re-extract the server pack.
  pause
  exit /b 1
)
${javaCheck}
if not exist eula.txt (
  echo First run: accept the Minecraft EULA.
  echo   https://aka.ms/MinecraftEULA
  echo Then create eula.txt containing:  eula=true
  pause
  exit /b 1
)

${neoInstall}java -Xms${Math.min(ram, 2048)}M -Xmx${ram}M -XX:+UseG1GC -XX:MaxGCPauseMillis=50 ${launchArgs} nogui
pause
`;
}

function serverInstructions(pack, serverFiles, launcher, requiredJava) {
  const ram = serverRamMb(pack);
  const java = requiredJava ? `Java ${requiredJava} or newer` : 'a current JDK';
  return [
    `${pack.name} ${pack.version} — SERVER PACK`,
    `Minecraft ${pack.minecraft} — ${pack.loader.type} ${pack.loader.version}`,
    `Requires ${java}.`,
    '',
    'SETUP',
    '',
    '1. Unzip this archive into an empty directory on the server.',
    `2. Install ${java} and make sure it is on PATH: https://adoptium.net/`,
    '   The start script checks this and refuses to run on anything older.',
    '3. Run start.sh (Linux/macOS) or start.bat (Windows).',
    '   The first run stops and asks you to accept the Minecraft EULA:',
    '   create a file named eula.txt containing exactly:  eula=true',
    `4. Run the start script again. ${pack.loader.type} downloads the Minecraft`,
    '   server and its libraries on first launch, so allow a few minutes and',
    '   keep it online.',
    '',
    `RAM: the scripts allocate ${ram} MB. Edit start.sh / start.bat to change it.`,
    'Do not raise it far beyond this — oversized heaps cause longer GC pauses,',
    'which players experience as lag spikes.',
    '',
    'WHAT IS IN HERE',
    '',
    `  mods/     ${serverFiles.filter((f) => f.kind === 'mod').length} server-side mods`,
    launcher
      ? `  ${launcher.fileName}  ${launcher.kind === 'installer' ? `${pack.loader.type} installer, run once by the start script` : `${pack.loader.type} server launcher`}`
      : '  (no launcher bundled)',
    '  start.sh / start.bat',
    '',
    'Client-only mods are deliberately absent — installing them here would waste',
    'memory at best and fail to load at worst. Players get those from the client',
    'pack; the two are built from one definition, so they cannot drift apart.',
    '',
    'PORTS',
    '',
    '  25565/tcp must be reachable for players to connect.',
    '  Edit server.properties after the first run to change it.',
    '',
    'Every mod keeps its own license — see LICENSES.txt.',
  ].join('\n');
}

/**
 * The third-party notice that travels inside the zips.
 *
 * This exists because of what the zips actually are. The `.mrpack` only names
 * files and lets the launcher fetch them, but the client and server archives
 * carry the real jars — so handing someone a zip is handing them the binaries,
 * and roughly a quarter of them are copyleft. Those licences ask that whoever
 * receives a binary can also get its source; naming where each one is published
 * is how that is answered without hosting anything ourselves.
 *
 * Nothing here relicenses anything. Every mod keeps its own terms.
 */
function licenceNotice(pack, files) {
  const copyleft = files.filter((f) => isCopyleft(f.license));
  const lines = [
    `${pack.name} ${pack.version} — third-party components`,
    '',
    `Minecraft ${pack.minecraft} — ${pack.loader.type} ${pack.loader.version}`,
    '',
    `This archive redistributes the ${files.length} files listed below. Each keeps its`,
    'own licence and copyright holders; being packaged together changes neither.',
    '',
    `${copyleft.length} of them are copyleft (GPL / LGPL / AGPL family). Those licences`,
    'ask that anyone given the compiled form can also obtain the source, so the',
    'source line below says where each is published.',
    '',
    'Licence identifiers are the ones the projects publish on Modrinth. Where a',
    'file was not resolved through Modrinth, its licence is stated as unknown and',
    "the project's own page is the reference.",
    '',
    ''.padEnd(70, '-'),
    '',
  ];
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${file.name} ${file.version}`);
    lines.push(`  file     ${file.fileName}`);
    lines.push(`  licence  ${file.license ?? 'unknown'}`);
    lines.push(`  source   ${file.sourceUrl ?? 'not published by the project'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function clientInstructions(pack, clientFiles) {
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
    `Contents: ${clientFiles.length} files (client-side only — server-only mods`,
    'are excluded, and are shipped in the separate server pack instead).',
    '',
    'Every mod keeps its own license — see LICENSES.txt.',
  ].join('\n');
}

/**
 * Write `dist/packs.json` — the catalogue the launcher reads to offer a choice.
 *
 * Built by scanning `dist/*&#47;pack.json` rather than from the packs this run
 * happened to build. `node build.mjs ravenclassic` builds one pack, and an index
 * regenerated from that run alone would silently drop every other pack from the
 * catalogue — publishing a one-entry list that looks correct.
 *
 * Carries no `mods[]`. The per-pack `pack.json` has the full list for anyone who
 * wants it; a catalogue that grows by a hundred entries per pack added is a
 * catalogue nobody can fetch to draw a menu.
 */
async function writeIndex() {
  const baseUrl = (process.env.PACK_BASE_URL ?? '').replace(/\/$/, '');
  const entries = [];

  for (const dir of await fs.readdir(DIST_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(DIST_DIR, dir.name, 'pack.json'), 'utf-8'));
    } catch {
      continue; // Not a pack — `raven-forge/` holds the launcher's feeds.
    }

    const mrpack = (await fs.readdir(path.join(DIST_DIR, dir.name))).find((f) =>
      f.endsWith('.mrpack'),
    );
    entries.push({
      slug: meta.slug,
      name: meta.name,
      version: meta.version,
      // Two fields on purpose. A launcher that predates `summaryI18n` reads
      // `summary` and would fail its whole catalogue parse on an object there,
      // taking the pack list with it — not just the description.
      summary: meta.summary,
      summaryI18n: meta.summaryI18n,
      minecraft: meta.minecraft,
      loader: meta.loader,
      recommendedRamMb: meta.recommendedRamMb,
      server: meta.server,
      counts: meta.counts,
      totalDownloadBytes: meta.totalDownloadBytes,
      builtAt: meta.builtAt,
      manifestUrl: baseUrl ? `${baseUrl}/${meta.slug}/manifest.json` : null,
      mrpackUrl: baseUrl && mrpack ? `${baseUrl}/${meta.slug}/${mrpack}` : null,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  // Null rather than a placeholder host: the launcher creates a profile from
  // `manifestUrl`, so a made-up address would produce a profile that fails on
  // its first sync. Absent is a state it can refuse; wrong is one it cannot.
  if (!baseUrl) warn('PACK_BASE_URL is unset — packs.json carries no URLs (CI sets this)');

  await fs.writeFile(
    path.join(DIST_DIR, 'packs.json'),
    JSON.stringify({ indexVersion: 1, generatedAt: new Date().toISOString(), packs: entries }, null, 2),
  );
  ok(`packs.json (${entries.length} pack(s))`);
}

/**
 * Copy `site/` into `dist/` verbatim.
 *
 * Not everything the Pages site serves is pack output. The launcher fetches its
 * news and announcement feeds from a URL too, and those are plain JSON nobody
 * builds — they are edited by hand and reviewed like any other change. Putting
 * them here means one Pages deployment, one CODEOWNERS gate, and no second
 * publishing surface to keep alive.
 *
 * `buildPack` only ever wipes `dist/<slug>`, so this runs last and survives.
 */
async function copySite() {
  const files = await listFiles(SITE_DIR).catch(() => []);
  if (files.length === 0) return;

  for (const file of files) {
    const dest = path.join(DIST_DIR, file.relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(file.absolute, dest);
  }
  ok(`${files.length} static file(s) from site/`);
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

  step('Catalogue');
  await writeIndex();

  step('Static site files');
  await copySite();

  console.log(`\n\x1b[1m\x1b[32mBuilt ${built.length} pack(s)\x1b[0m → dist/`);
  for (const { meta, outDir } of built) {
    console.log(`  ${meta.name} ${meta.version} → ${path.relative(ROOT, outDir)}/`);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
