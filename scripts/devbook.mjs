#!/usr/bin/env node
// Somewhere to look at the guide book before releasing it.
//
// The book is two halves that travel by different roads, and both have to be
// short-circuited or there is nothing to look at:
//
//   structure  world/datapacks/ravenclassic-guide/  — categories, entries, pages
//   text       server-resourcepack/                 — every string players read
//
// In production the text arrives as a resource pack the server pushes by URL and
// sha1, which is why changing one word normally means cutting a release to see
// it. Installed here as a *folder* pack it needs neither, and Minecraft re-reads
// it on every resource reload.
//
// Once installed, the whole loop is: edit the file, re-run this, then in game
//
//     /modonomicon reload
//
// Modonomicon's own command, and it does the two steps in the order that
// matters: it tells the client to reload resources, waits for it to report back,
// and only then reloads datapacks server-side. The book's text is baked into
// components once, when books sync, so text reloaded after that point would be
// ignored — which is exactly why /reload and F3+T on their own do nothing here.
// The command needs permission level 2, so the test world needs cheats.
//
// Usage:
//   node scripts/devbook.mjs --create           # profile + the two mods + the text
//   node scripts/devbook.mjs --world "Test"     # once the world exists, add the book
//   node scripts/devbook.mjs                    # refresh the text after an edit
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..');
const SLUG = 'ravenclassic';
const PROFILE_NAME = 'Przewodnik — test lokalny';
// Modonomicon renders the book and fabric-api is all it asks for. Anything else
// from the pack is weight that has nothing to do with reading a page.
const NEEDED = ['fabric-api', 'modonomicon'];

const SRC = {
  resourcepack: path.join(REPO, 'packs', SLUG, 'server-resourcepack'),
  datapack: path.join(REPO, 'packs', SLUG, 'server-overrides/world/datapacks', `${SLUG}-guide`),
  lock: path.join(REPO, 'packs', SLUG, 'pack.lock.json'),
};

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

function launcherDir() {
  const override = opt('launcher');
  if (override) return path.resolve(override);
  const name = 'Raven Forge Launcher';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), name);
  return path.join(os.homedir(), '.config', name);
}

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  let files = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else files++;
    }
  })(to);
  return files;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// The lockfile already records every URL and hash, so this needs no API calls
// and can prove it downloaded the jar the pack is pinned to.
async function installMods(minecraftDir) {
  const lock = JSON.parse(fs.readFileSync(SRC.lock, 'utf8'));
  const mods = path.join(minecraftDir, 'mods');
  fs.mkdirSync(mods, { recursive: true });

  for (const id of NEEDED) {
    const file = lock.files.find((f) => f.id === id);
    if (!file) throw new Error(`${id} is not in ${path.basename(SRC.lock)} — has the pack changed?`);
    const dest = path.join(mods, file.fileName);

    if (fs.existsSync(dest) && sha1(fs.readFileSync(dest)) === file.sha1) {
      console.log(`mods      ${file.fileName} (already there)`);
      continue;
    }
    process.stdout.write(`mods      ${file.fileName} … `);
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`${file.url} returned ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (sha1(data) !== file.sha1) throw new Error(`${file.fileName} does not match the hash in the lockfile`);
    fs.writeFileSync(dest, data);
    console.log(`${(data.length / 1048576).toFixed(1)} MiB, hash ok`);
  }
}

function createProfile(dir) {
  const file = path.join(dir, 'profiles.json');
  const profiles = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];

  let profile = profiles.find((p) => p.name === PROFILE_NAME);
  if (!profile) {
    const now = new Date().toISOString();
    profile = {
      name: PROFILE_NAME,
      minecraftVersion: '26.2',
      modLoader: 'fabric',
      modLoaderVersion: '0.19.3',
      allocatedRamMb: 4096,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    // Deliberately no manifestUrl: syncing a pack would replace the two mods
    // installed here with the whole published pack.
    profiles.push(profile);
    fs.writeFileSync(file, JSON.stringify(profiles, null, 2) + '\n');
    console.log(`profile   created "${PROFILE_NAME}"`);
  } else {
    console.log(`profile   reusing "${PROFILE_NAME}"`);
  }
  return path.join(dir, 'profiles', profile.id, '.minecraft');
}

function findProfile(dir) {
  const file = path.join(dir, 'profiles.json');
  if (!fs.existsSync(file)) return null;
  const profile = JSON.parse(fs.readFileSync(file, 'utf8')).find((p) => p.name === PROFILE_NAME);
  return profile ? path.join(dir, 'profiles', profile.id, '.minecraft') : null;
}

const dir = launcherDir();
if (!fs.existsSync(dir)) {
  console.error(`No launcher directory at ${dir}. Pass --launcher <path>.`);
  process.exit(1);
}

let minecraftDir;
if (has('create')) {
  minecraftDir = createProfile(dir);
  fs.mkdirSync(minecraftDir, { recursive: true });
  await installMods(minecraftDir);

  // The book is written in Polish first, so open in Polish; and switch the pack
  // on so it does not have to be found in the menus.
  const options = path.join(minecraftDir, 'options.txt');
  if (!fs.existsSync(options)) {
    fs.writeFileSync(options, `lang:pl_pl\nresourcePacks:["file/${SLUG}-guide-dev"]\n`);
    console.log('options   language pl_pl, guide pack switched on');
  }
} else {
  minecraftDir = findProfile(dir);
  if (!minecraftDir) {
    console.error(`No profile named "${PROFILE_NAME}" yet. Run with --create first.`);
    process.exit(1);
  }
}

console.log(`profile   ${minecraftDir}`);

const rpDest = path.join(minecraftDir, 'resourcepacks', `${SLUG}-guide-dev`);
console.log(`text      ${copyTree(SRC.resourcepack, rpDest)} files -> resourcepacks/${SLUG}-guide-dev/`);

const saves = path.join(minecraftDir, 'saves');
const worlds = fs.existsSync(saves)
  ? fs.readdirSync(saves).filter((w) => fs.existsSync(path.join(saves, w, 'level.dat')))
  : [];
// With one world there is nothing to choose, so refreshing the book after an
// edit stays a single command.
const world = opt('world') ?? (worlds.length === 1 ? worlds[0] : null);

if (world) {
  if (!worlds.includes(world)) {
    console.error(`\nNo world named "${world}" in ${saves}.`);
    if (worlds.length) console.error(`Have: ${worlds.join(', ')}`);
    process.exit(1);
  }
  const dpDest = path.join(saves, world, 'datapacks', `${SLUG}-guide`);
  console.log(`structure ${copyTree(SRC.datapack, dpDest)} files -> saves/${world}/datapacks/${SLUG}-guide/`);
  console.log(`
In game:
  /modonomicon reload
  /give @s modonomicon:modonomicon[modonomicon:book_id="${SLUG}:przewodnik"]`);
} else if (worlds.length === 0) {
  console.log(`
No world yet. In the launcher, play "${PROFILE_NAME}", then create a
singleplayer world with cheats on and quit back out. Then:

  node scripts/devbook.mjs --world "<name>"`);
} else {
  console.log(`\nWorlds available: ${worlds.join(', ')}`);
  console.log('Re-run with --world "<name>" to install the book into one.');
}
