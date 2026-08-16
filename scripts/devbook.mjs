#!/usr/bin/env node
// Put the guide book into a local Minecraft profile so a wording change can be
// seen in game in seconds, instead of cutting a release to find out.
//
// The book is two halves that travel by different roads, and both have to be
// short-circuited or the loop is pointless:
//
//   structure  world/datapacks/ravenclassic-guide/  — categories, entries, pages
//   text       server-resourcepack/                 — every string players read
//
// In production the text arrives as a resource pack the server pushes by URL and
// sha1, which is why changing one word normally means a new release. Installed
// here as a *folder* pack it needs neither, and Minecraft re-reads it on every
// resource reload.
//
// Once installed, the whole loop is: edit the file, then in game run
//
//     /modonomicon reload
//
// Modonomicon's own command, and it does the two steps in the order that
// matters: it tells the client to reload resources, waits for it to report back,
// and only then reloads datapacks server-side. The book's text is baked into
// components once, when books sync, so text reloaded after that point would be
// ignored — which is exactly why /reload and F3+T on their own do nothing here.
// The command needs permission level 2, so a singleplayer world needs cheats.
//
// Usage:
//   node scripts/devbook.mjs                    # list profiles and worlds
//   node scripts/devbook.mjs --world Testowy    # install into that world
//   node scripts/devbook.mjs --profile <path> --world Testowy
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(import.meta.dirname, '..');
const SLUG = 'ravenclassic';
const SRC = {
  resourcepack: path.join(REPO, 'packs', SLUG, 'server-resourcepack'),
  datapack: path.join(REPO, 'packs', SLUG, 'server-overrides/world/datapacks', `${SLUG}-guide`),
};

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

// Raven Forge keeps one .minecraft per profile under its Electron config dir.
function profileRoots() {
  const base = path.join(os.homedir(), '.config', 'Raven Forge Launcher', 'profiles');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .map((id) => path.join(base, id, '.minecraft'))
    .filter((dir) => fs.existsSync(dir));
}

// The guide is useless in a profile without the mod that renders it, so prefer
// one that has it rather than picking the first directory that exists.
function hasModonomicon(root) {
  const mods = path.join(root, 'mods');
  return fs.existsSync(mods) && fs.readdirSync(mods).some((f) => /modonomicon/i.test(f));
}

function worldsIn(root) {
  const saves = path.join(root, 'saves');
  if (!fs.existsSync(saves)) return [];
  return fs.readdirSync(saves).filter((w) => fs.existsSync(path.join(saves, w, 'level.dat')));
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

const explicit = opt('profile');
const roots = explicit ? [path.resolve(explicit)] : profileRoots();
if (roots.length === 0) {
  console.error('No Raven Forge profile found. Pass --profile <path to .minecraft>.');
  process.exit(1);
}

const withMod = roots.filter(hasModonomicon);
const candidates = explicit ? roots : withMod;

if (candidates.length === 0) {
  console.error('No profile has Modonomicon installed. Found:\n');
  for (const r of roots) console.error(`  ${r}`);
  console.error('\nInstall the pack in one of them first, or pass --profile <path>.');
  process.exit(1);
}
if (candidates.length > 1) {
  console.error('Several profiles have the mod — pick one with --profile:\n');
  for (const r of candidates) console.error(`  ${r}`);
  process.exit(1);
}

const root = candidates[0];
const worlds = worldsIn(root);
const world = opt('world');

console.log(`profile   ${root}`);

const rpDest = path.join(root, 'resourcepacks', `${SLUG}-guide-dev`);
const rpFiles = copyTree(SRC.resourcepack, rpDest);
console.log(`text      ${rpFiles} files -> resourcepacks/${SLUG}-guide-dev/`);

if (!world) {
  console.log('\nWorlds available:');
  for (const w of worlds) console.log(`  ${w}`);
  console.log(`\nRe-run with --world "<name>" to install the book structure into one.`);
  console.log('Enable the pack once under Options -> Resource Packs; it stays enabled.');
  process.exit(0);
}

if (!worlds.includes(world)) {
  console.error(`\nNo world named "${world}" in ${path.join(root, 'saves')}.`);
  if (worlds.length) console.error(`Have: ${worlds.join(', ')}`);
  process.exit(1);
}

const dpDest = path.join(root, 'saves', world, 'datapacks', `${SLUG}-guide`);
const dpFiles = copyTree(SRC.datapack, dpDest);
console.log(`structure ${dpFiles} files -> saves/${world}/datapacks/${SLUG}-guide/`);

console.log(`
Next, once:
  Options -> Resource Packs -> enable "${SLUG}-guide-dev"
  open the world with cheats on

Then for every change:
  node scripts/devbook.mjs --world "${world}"
  /modonomicon reload
  /give @s modonomicon:modonomicon[modonomicon:book_id="${SLUG}:przewodnik"]`);
