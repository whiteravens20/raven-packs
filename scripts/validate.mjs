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
import { isCopyleft } from './lib/licences.mjs';

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
 *
 * Which keys are correct depends on the version, so this cannot be a blanket
 * rule. A pack for a Minecraft old enough to predate the changeover has to use
 * `pack_format`, and `min_format`/`max_format` mean nothing to it — ravenforge
 * is on 1.21.1, data format 48, and its datapack loads only with the old key.
 * So the test is the declared number, not the key: below the changeover the old
 * key is required, at or above it the new pair is.
 */

/** `PackFormat.lastPreMinorVersion` — the last format before the key change. */
const LAST_PRE_MINOR = { resource: 64, data: 81 };
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
    const kind = file.relative.includes('datapacks/') ? 'data' : 'resource';
    const threshold = LAST_PRE_MINOR[kind];
    const legacy = ['pack_format', 'supported_formats'].filter((k) => k in section);
    const modern = ['min_format', 'max_format'].filter((k) => k in section);

    // The highest format the file claims, whichever key it used to claim it.
    const claimed = Math.max(
      ...[section.pack_format, section.max_format, ...(section.supported_formats?.max ? [section.supported_formats.max] : [])]
        .filter((n) => typeof n === 'number'),
      -1,
    );

    if (claimed < 0) {
      fail(slug, `${file.relative} declares no pack format at all — the game cannot read its metadata`);
    } else if (claimed > threshold) {
      if (legacy.length > 0) {
        fail(slug, `${file.relative} claims ${kind} format ${claimed}, past ${threshold}, while still using ${legacy.join(' and ')} — replace with min_format/max_format`);
      }
      const missing = ['min_format', 'max_format'].filter((k) => !(k in section));
      if (missing.length > 0) {
        fail(slug, `${file.relative} is missing ${missing.join(' and ')} — the game cannot read its metadata`);
      }
    } else if (modern.length > 0) {
      fail(slug, `${file.relative} uses ${modern.join(' and ')} at ${kind} format ${claimed}, which predates them — use pack_format`);
    }
  }

  if (metas.length > 0 && problems.length === before) {
    console.log(`  \x1b[32m✓\x1b[0m ${metas.length} pack.mcmeta declare a format the game can read`);
  }
}

/**
 * `summary` is either a plain string or a `{ locale: text }` map.
 *
 * The map is the interesting case and it fails quietly in two ways the build
 * cannot see. A blank value looks set in the file and is dropped on the way
 * out, so the language it claimed to cover ends up served by the fallback. And
 * a map with no `en` still builds: the .mrpack takes whatever language is
 * first, which means somebody opening the pack in the Modrinth app reads
 * Polish. Neither is an error anywhere downstream — they are just wrong.
 */
function validateSummary(slug, pack) {
  const summary = pack.summary;
  if (summary === undefined || typeof summary === 'string') return;
  if (typeof summary !== 'object' || Array.isArray(summary)) {
    fail(slug, 'summary must be a string or a { locale: text } object');
    return;
  }

  const entries = Object.entries(summary);
  if (entries.length === 0) {
    fail(slug, 'summary is an empty object — give it a language or drop the field');
    return;
  }
  for (const [locale, text] of entries) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale)) {
      fail(slug, `summary key "${locale}" is not a locale code (expected e.g. "en" or "pt-BR")`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      fail(slug, `summary.${locale} is empty — a blank string is dropped at build time, not shown`);
    }
  }
  // Only absence — the loop above already covers an `en` that is present and
  // blank, and two messages about one field read like two problems.
  if (!('en' in summary)) {
    fail(slug, 'summary needs "en" — it is what the .mrpack carries to other launchers');
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
  validateSummary(slug, pack);
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
  await validateBookItems(slug, pack);
  await validateBookLayout(slug);
  await validateBookText(slug);
  await validateBookPages(slug);

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

  // The zips carry real jars, so shipping one is conveying compiled code. For a
  // copyleft mod that comes with an obligation to say where the source is, and
  // the only honest way to meet it is to name the project's own repository.
  //
  // This is a hard failure rather than a warning because the case it catches is
  // invisible otherwise: a mod whose published jar contains classes that were
  // never released as source. Nothing downstream would notice, and by then the
  // binary is already inside an archive somebody has downloaded.
  const unsourced = lock.files.filter((f) => isCopyleft(f.license) && !f.sourceUrl);
  if (unsourced.length > 0) {
    for (const f of unsourced) {
      fail(slug, `"${f.id}" is ${f.license} but publishes no source URL — the zips would convey it with no way to obtain the source`);
    }
    return;
  }
  const copyleft = lock.files.filter((f) => isCopyleft(f.license));
  console.log(`  \x1b[32m✓\x1b[0m ${copyleft.length} copyleft component(s) name where their source lives`);

  // Modrinth's own version_type where we have it. The name pattern is the
  // fallback for url entries, which carry no type — on its own it misses a
  // beta that happens to be numbered like a release.
  const prereleases = lock.files.filter((f) =>
    f.versionType ? f.versionType !== 'release' : /alpha|beta|snapshot|-rc/i.test(f.version),
  );
  if (prereleases.length > 0) {
    console.log(`  \x1b[33m!\x1b[0m ${prereleases.length} prerelease version(s): ${prereleases.map((f) => f.id).join(', ')}`);
  }

  console.log(`  \x1b[32m✓\x1b[0m lockfile in sync — ${lock.files.length} files, locked ${lock.generatedAt.slice(0, 10)}`);
}

/**
 * An item named inside the guide book has to exist on the client.
 *
 * A Modonomicon spotlight page names an item, and the id is resolved against
 * the *client's* registry when the book syncs on join. Name a mod that only
 * ships to the server and that page fails to decode, the book collects a
 * blocking error, and Modonomicon then skips pre-rendering markdown for the
 * entire book — so every page in it comes out blank while the node view looks
 * perfect and nothing in the build says a word.
 *
 * That shipped in 1.5.2, from one spotlight naming a Universal Shops block.
 * The namespace is checked with underscores as well as dashes because a mod's
 * Modrinth slug and its registry namespace disagree exactly often enough
 * (`universal-shops` against `universal_shops`) to be the thing that hides it.
 */
async function validateBookItems(slug, pack) {
  const serverOnly = new Set(
    (pack.mods ?? [])
      .filter((mod) => mod.side === 'server' && mod.slug)
      .flatMap((mod) => [mod.slug, mod.slug.replace(/-/g, '_')]),
  );
  if (serverOnly.size === 0) return;

  let pages;
  try {
    pages = (await listFiles(path.join(PACKS_DIR, slug, 'server-overrides'))).filter(
      (file) => file.relative.includes('/modonomicon/books/') && file.relative.endsWith('.json'),
    );
  } catch {
    return;
  }
  if (pages.length === 0) return;

  for (const page of pages) {
    let json;
    try {
      json = JSON.parse(await fs.readFile(page.absolute, 'utf8'));
    } catch (error) {
      fail(slug, `${page.relative} is not valid JSON: ${error.message}`);
      continue;
    }
    const item = typeof json.item === 'string' ? json.item : json.item?.id;
    if (typeof item !== 'string') continue;
    const namespace = item.replace(/^#/, '').split(':')[0];
    if (serverOnly.has(namespace)) {
      fail(
        slug,
        `${page.relative} shows "${item}", but ${namespace} ships to the server only — ` +
          'the client cannot resolve that id and the whole book renders blank',
      );
    }
  }

  console.log(`  \x1b[32m✓\x1b[0m ${pages.length} guide book file(s) name only client-side items`);
}

/**
 * A Modonomicon page is found by where it sits, not by what it says.
 *
 * The layout the mod expects is `entries/<category>/<entry>/pages/`, and it
 * resolves that `<category>` segment against the book's real categories before
 * attaching anything. Merge or rename a category without moving the directories
 * and every page quietly fails to attach: the node view renders perfectly,
 * every page in the book comes out blank, and neither the build nor the game
 * says a word about it. That shipped in 1.5.2 and survived a hotfix, because
 * the symptom looks like a rendering problem and the cause is a path.
 *
 * The entry's own `id` and `category` are checked against the same path for the
 * same reason — the pages are matched to an entry by the id the path implies,
 * so a file that disagrees with its own location attaches nothing.
 */
async function validateBookLayout(slug) {
  let files;
  try {
    files = await listFiles(path.join(PACKS_DIR, slug, 'server-overrides'));
  } catch {
    return;
  }

  const books = new Map();
  for (const file of files) {
    const match = file.relative.match(/^(?<root>.*\/([^/]+)\/modonomicon\/books\/[^/]+)\/(?<rest>.+)$/);
    if (!match) continue;
    const { root, rest } = match.groups;
    if (!books.has(root)) books.set(root, { namespace: match[2], contents: [] });
    books.get(root).contents.push({ rest, absolute: file.absolute });
  }
  if (books.size === 0) return;

  let checked = 0;
  for (const [root, { namespace, contents }] of books) {
    const categories = new Set(
      contents
        .map((file) => file.rest.match(/^categories\/([^/]+)\.json$/)?.[1])
        .filter(Boolean),
    );

    for (const file of contents) {
      const parts = file.rest.match(/^entries\/([^/]+)\/([^/]+)\.json$/);
      if (!parts) continue;
      const [, category, name] = parts;
      checked++;

      if (!categories.has(category)) {
        fail(
          slug,
          `${root}/entries/${category}/ names no category in this book — Modonomicon finds pages by ` +
            'that path, so every page under it stays unattached and renders blank',
        );
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(await fs.readFile(file.absolute, 'utf8'));
      } catch (error) {
        fail(slug, `${file.rest} is not valid JSON: ${error.message}`);
        continue;
      }
      const wantCategory = `${namespace}:${category}`;
      const wantId = `${namespace}:${category}/${name}`;
      if (entry.category !== wantCategory) {
        fail(slug, `${file.rest} sits in ${category}/ but claims category "${entry.category}" — expected "${wantCategory}"`);
      }
      if (entry.id !== wantId) {
        fail(slug, `${file.rest} claims id "${entry.id}" — expected "${wantId}", or its pages attach to nothing`);
      }
    }
  }

  if (checked > 0) console.log(`  \x1b[32m✓\x1b[0m ${checked} guide book entr(ies) sit under a real category`);
}

/**
 * Book text has to survive Modonomicon's markdown renderer.
 *
 * `CoreComponentNodeRenderer` claims the Paragraph node type but implements no
 * visitor for it, so a blank line between two paragraphs emits *nothing at all*
 * and the sentences render fused: "…zależy od rangi.Nie ma teleportu…". That
 * shipped in every release up to 1.5.4. A hard line break — a backslash ending
 * the line — is the separator that actually works.
 *
 * The same backslash immediately before a list is the opposite trap. There it
 * falls at the end of its block, where CommonMark keeps it as an ordinary
 * character, and a stray "\" appears on the page. A list already starts its own
 * line, so that boundary wants nothing.
 *
 * Both are invisible in the source and only show up in game, which is what
 * makes them worth a gate rather than a habit.
 */
/**
 * The two rules above, applied to one string.
 *
 * Shared because the text reaches the same renderer by two routes: behind a
 * lang key in a resource pack (ravenclassic) and inline in the page's own JSON
 * (ravenforge, whose Modonomicon reads `text` as a literal when it is not a
 * translation key). The renderer does not care which, so neither does this.
 */
function checkMarkdownBreaks(slug, where, value) {
  const isListItem = (line) => /^\s*[-*+]\s+/.test(line);
  const lines = value.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') continue;
    const before = [...lines.slice(0, i)].reverse().find((line) => line.trim() !== '');
    const after = lines.slice(i + 1).find((line) => line.trim() !== '');
    if (before && after && !isListItem(before) && !isListItem(after)) {
      fail(
        slug,
        `${where} splits paragraphs with a blank line, which Modonomicon renders as ` +
          'nothing — end the line with a backslash instead',
      );
    }
  }

  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].endsWith('\\') && isListItem(lines[i + 1])) {
      fail(slug, `${where} ends a line with a backslash right before a list, which renders as a literal "\\"`);
    }
  }
}

async function validateBookText(slug) {
  let files;
  try {
    files = await listFiles(path.join(PACKS_DIR, slug, 'server-resourcepack'));
  } catch {
    return;
  }
  const langs = files.filter((file) => /\/lang\/[a-z]{2}_[a-z]{2}\.json$/.test(file.relative));
  if (langs.length === 0) return;

  const keysets = new Map();
  let checked = 0;

  for (const file of langs) {
    let lang;
    try {
      lang = JSON.parse(await fs.readFile(file.absolute, 'utf8'));
    } catch (error) {
      fail(slug, `${file.relative} is not valid JSON: ${error.message}`);
      continue;
    }
    keysets.set(file.relative, new Set(Object.keys(lang)));

    for (const [key, value] of Object.entries(lang)) {
      if (!key.endsWith('.text') || typeof value !== 'string') continue;
      checked++;
      checkMarkdownBreaks(slug, `${file.relative}: ${key}`, value);
    }
  }

  // The languages have to describe the same server, so they carry the same keys.
  const sets = [...keysets.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const [nameA, setA] = sets[i];
      const [nameB, setB] = sets[j];
      for (const key of setA) if (!setB.has(key)) fail(slug, `${key} is in ${nameA} but missing from ${nameB}`);
      for (const key of setB) if (!setA.has(key)) fail(slug, `${key} is in ${nameB} but missing from ${nameA}`);
    }
  }

  if (checked > 0) console.log(`  \x1b[32m✓\x1b[0m ${checked} guide book text(s) render with their paragraphs separated`);
}

/**
 * ravenforge writes its book inline, and its ids come from the file path.
 *
 * Modonomicon 1.120.4 has no `id` field on an entry at all — BookDataManager
 * splits the resource path on "/", takes the first segment as the book id and
 * keeps the whole location as the entry's own. So `<ns>:<book>/<rest>` IS the
 * id, and a `category` or a `parents` entry that names anything else points at
 * nothing. Its page text is inline too, read as a literal when it is not a
 * translation key, which puts it out of reach of the lang-file check above and
 * in reach of exactly the same two renderer traps.
 *
 * An entry that declares its own `id` belongs to the older layout and is left
 * to validateBookLayout — the two Modonomicon versions in this repo disagree
 * about where an id comes from, and only one of them can be right per pack.
 */
async function validateBookPages(slug) {
  let files;
  try {
    files = await listFiles(path.join(PACKS_DIR, slug, 'server-overrides'));
  } catch {
    return;
  }
  const inBooks = files.filter(
    (file) => /\/modonomicon\/books\//.test(file.relative) && file.relative.endsWith('.json'),
  );
  if (inBooks.length === 0) return;

  const idOf = (relative) => {
    const match = relative.match(/\/data\/([^/]+)\/modonomicon\/books\/(.+)\.json$/);
    return match ? `${match[1]}:${match[2]}` : null;
  };
  const known = new Set(inBooks.map((file) => idOf(file.relative)).filter(Boolean));

  let checked = 0;
  for (const file of inBooks) {
    const id = idOf(file.relative);
    if (id === null || !/\/entries\//.test(file.relative)) continue;

    let entry;
    try {
      entry = JSON.parse(await fs.readFile(file.absolute, 'utf8'));
    } catch (error) {
      fail(slug, `${file.relative} is not valid JSON: ${error.message}`);
      continue;
    }
    if (entry.id !== undefined) continue;

    if (typeof entry.category === 'string' && !known.has(entry.category)) {
      fail(slug, `${file.relative} names category "${entry.category}", which is no file in this book — the entry renders nowhere`);
    }
    for (const parent of entry.parents ?? []) {
      if (typeof parent.entry === 'string' && !known.has(parent.entry)) {
        fail(slug, `${file.relative} names parent "${parent.entry}", which is no entry in this book`);
      }
    }

    const pages = Array.isArray(entry.pages) ? entry.pages : [];
    for (let i = 0; i < pages.length; i++) {
      for (const field of ['title', 'text']) {
        const value = pages[i][field];
        if (typeof value !== 'string') continue;
        checked++;
        checkMarkdownBreaks(slug, `${file.relative}: page ${i + 1} ${field}`, value);
      }
    }
  }

  if (checked > 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${checked} inline book text(s) render and point where they say`);
  }
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
