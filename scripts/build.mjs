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
 *
 * Plus one file for the whole site:
 *
 *   packs.json                 Catalogue of every pack in dist/ — what the
 *                              launcher fetches to offer a choice.
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
    summary: pack.summary ?? '',
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
  if (overrideContents.length > 0) ok(`${overrideContents.length} client override files`);
  if (serverOverrides.length > 0) ok(`${serverOverrides.length} server override files`);

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
      for (const file of serverOverrides) serverZip.add(file.relative, file.data);

      const launcher = lock.pack.serverLauncher;
      if (launcher) {
        const jar = await fetchFile(launcher.url);
        serverZip.add(launcher.fileName, jar.data, { store: true });
        ok(`bundled ${launcher.fileName} (Fabric installer ${launcher.installerVersion})`);
      } else {
        warn(`no server launcher for loader "${pack.loader.type}" — admins must install it manually`);
      }

      const requiredJava = lock.pack.requiredJava;
      // 0o755 so an admin can run ./start.sh straight out of the archive.
      serverZip.add('start.sh', startScriptUnix(pack, launcher, requiredJava), { mode: 0o755 });
      serverZip.add('start.bat', crlf(startScriptWindows(pack, launcher, requiredJava)));
      serverZip.add('SERVER-INSTALL.txt', crlf(serverInstructions(pack, serverFiles, launcher, requiredJava)));

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
    summary: pack.summary ?? '',
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

exec java -Xms${Math.min(ram, 2048)}M -Xmx${ram}M \\
  -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \\
  -jar "${jar}" nogui
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

java -Xms${Math.min(ram, 2048)}M -Xmx${ram}M -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -jar "${jar}" nogui
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
    '4. Run the start script again. Fabric downloads the Minecraft server and',
    '   its libraries on first launch, so allow a few minutes and keep it online.',
    '',
    `RAM: the scripts allocate ${ram} MB. Edit start.sh / start.bat to change it.`,
    'Do not raise it far beyond this — oversized heaps cause longer GC pauses,',
    'which players experience as lag spikes.',
    '',
    'WHAT IS IN HERE',
    '',
    `  mods/     ${serverFiles.filter((f) => f.kind === 'mod').length} server-side mods`,
    launcher ? `  ${launcher.fileName}  Fabric server launcher` : '  (no launcher bundled)',
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
    'Every mod keeps its own license.',
  ].join('\n');
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
    'Every mod keeps its own license — see pack.json for the list.',
  ].join('\n');
}

/**
 * Write `dist/packs.json` — the catalogue the launcher reads to offer a choice.
 *
 * Built by scanning `dist/*&#47;pack.json` rather than from the packs this run
 * happened to build. `node build.mjs ravenmc` builds one pack, and an index
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
      summary: meta.summary,
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
