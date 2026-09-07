#!/usr/bin/env node
/**
 * Regenerates the Silent Gear material overrides in ravenforge's block datapack.
 *
 * The pack moves the start of gear progression up to iron. Silent Gear ships 72
 * materials that can serve as a tool's main part, and 22 of them sit at
 * `level_hint` 1.5 or below — below iron's 2 — which would let a player skip the
 * early game with a stone or copper pickaxe head that outlasts an iron one
 * (end stone: 1164 durability at tier 1, against iron's 250 at tier 2).
 *
 * Two mechanisms, and the difference matters:
 *
 *   - Dropping the `silentgear:main` block from `properties` removes the
 *     material from *main parts only*. `AbstractMaterial.isAllowedInPart` is
 *     `getPartTypes().contains(part)` and `getPartTypes` is `properties.keySet()`
 *     unioned with the parent's, so a material with no `main` entry cannot be a
 *     main part while staying available as a rod, tip, setting or coating. That
 *     is what we want for nearly all of them: wooden rods and gold tips are not
 *     the problem, wooden pickaxe heads are.
 *   - `gear_type_blacklist: ["silentgear:all"]` removes the material from gear
 *     entirely. `isGearTypeBlacklisted` is consulted per gear type inside
 *     `isCraftingAllowed`, so "all" leaves no way to use the material anywhere.
 *     Reserved for the two materials that must not be gear at any weight.
 *
 * A datapack file replaces its counterpart whole — nothing merges — so each
 * override is the upstream file with one edit. That means these files pin
 * upstream's numbers: after a Silent Gear update, rerun this script against the
 * new jar or the pack will quietly keep serving the old stats.
 *
 *   node scripts/gen-silentgear-blocks.mjs <path-to-silent-gear.jar>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const jar = process.argv[2];
if (!jar) {
  console.error('usage: node scripts/gen-silentgear-blocks.mjs <path-to-silent-gear.jar>');
  process.exit(1);
}

const OUT = 'packs/ravenforge/server-overrides/world/datapacks/ravenforge-blocks/data/silentgear/silentgear_materials';
const IN_JAR = 'data/silentgear/silentgear_materials';

/** Below iron. Iron is level_hint 2; everything at or under this is early game. */
const MAX_LEVEL_HINT = 1.5;

/**
 * Not gear at all, for a reason that is not about progression.
 *
 * `amethyst` is the RavenCoin ingredient. A tip or a setting is still a use
 * that competes with minting for the same finite supply, and the pack's whole
 * currency argument rests on amethyst having no utility value.
 * `barrier` is a creative-only block with 1337 durability at tier 0 — it has no
 * recipe, so no player should ever hold one, and blacklisting it costs nothing.
 */
const NO_GEAR_AT_ALL = new Set(['amethyst', 'barrier']);

const list = execFileSync('unzip', ['-Z1', jar, `${IN_JAR}/*.json`], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const written = [];
const skipped = [];

for (const path of list) {
  const id = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
  const raw = execFileSync('unzip', ['-p', jar, path], { encoding: 'utf8' });
  const doc = JSON.parse(raw);

  const main = doc.properties?.['silentgear:main'];
  if (!main) continue; // cannot be a main part in the first place

  const hint = Number(main.harvest_tier?.level_hint);
  if (!Number.isFinite(hint) || hint > MAX_LEVEL_HINT) continue;

  // Already blacklisted upstream — an override would only pin it to this version.
  if (doc.crafting?.gear_type_blacklist?.length) {
    skipped.push(id);
    continue;
  }

  // Both, for the two that must not be gear at all: dropping `main` is the half
  // a live server can show back (`/sgear_mats describe` prints part types but
  // says nothing about the blacklist), and the blacklist closes the tip, setting
  // and coating uses that dropping `main` leaves open.
  delete doc.properties['silentgear:main'];
  if (NO_GEAR_AT_ALL.has(id)) {
    doc.crafting.gear_type_blacklist = ['silentgear:all'];
  }

  written.push({ id, hint, mode: NO_GEAR_AT_ALL.has(id) ? 'no gear' : 'no main part' });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
}

// Anything left from an older run would silently keep overriding.
for (const f of readdirSync(OUT)) {
  if (!written.some((w) => `${w.id}.json` === f)) {
    rmSync(join(OUT, f));
    console.log(`  removed stale ${f}`);
  }
}

written.sort((a, b) => a.hint - b.hint || a.id.localeCompare(b.id));
for (const w of written) console.log(`  ${w.id.padEnd(14)} level_hint ${String(w.hint).padEnd(4)} ${w.mode}`);
if (skipped.length) console.log(`\n  already blacklisted upstream, left alone: ${skipped.join(', ')}`);
console.log(`\n${written.length} material override(s) written to ${OUT}`);
