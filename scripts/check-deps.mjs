#!/usr/bin/env node
/**
 * Resolve the pack's mod dependencies the way the mod loader will at startup.
 *
 *   node scripts/check-deps.mjs                # every pack
 *   node scripts/check-deps.mjs ravenclassic   # one pack
 *
 * Why this exists, and why the lockfile is not enough.
 *
 * `lock.mjs` asks Modrinth which projects a version depends on. Modrinth
 * answers with project ids and, for most entries, `version_id: null` — it says
 * *that* Waystones needs Balm, never *which* Balm. The real requirement is a
 * version predicate inside the jar's own metadata, and nothing that talks to
 * the API can see it.
 *
 * That gap shipped a broken pack: Waystones was bumped to 26.2.0.9, whose
 * project-level dependency list was byte-identical to 26.2.0.7's, so the bump
 * looked clean from the API. The jar wanted `balm >=26.2.0.6` and the pack had
 * 26.2.0.5, and the first person to launch it got a Fabric Loader crash screen
 * instead of a game. This script reads the jars.
 *
 * It also walks nested jars (`META-INF/jars/` on Fabric, `META-INF/jarjar/` on
 * NeoForge), because a mod id can be satisfied by a module bundled inside
 * another mod — most of `fabric-api` is exactly that, and treating those as
 * missing would bury the real failures.
 *
 * Both loaders are handled, and the difference is not cosmetic. Fabric declares
 * dependencies as semver-ish predicates in `fabric.mod.json`; NeoForge declares
 * them as **Maven version ranges** in `META-INF/neoforge.mods.toml`. Reading a
 * NeoForge jar with the Fabric path finds nothing, and a script that skips every
 * jar still prints a green tick — which is worse than no check at all.
 *
 * That is not hypothetical. `sdm-shop` 3.2.0 declares zero dependencies on
 * Modrinth and names only `architectury` in its TOML, while its bytecode
 * references `dev/ftb/mods/ftblibrary` 140 times and bundles none of it. The
 * lockfile is happy, the API is happy, and the server dies on boot.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchFile, listFiles } from "./lib/download.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKS_DIR = path.join(ROOT, "packs");
const CACHE = path.join(ROOT, ".cache", "downloads");

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const dim = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

// ── Version comparison ───────────────────────────────────────
//
// Fabric versions are "semver-ish": `26.2.0.6+fabric-26.2` has four numeric
// parts, not three, and the build metadata after `+` never participates in
// ordering. Compare the numeric run, pad the shorter side with zeros, and fall
// back to a string compare when a part is not a number (`1.0.0-beta.2`).

function parseVersion(v) {
  return String(v)
    .split("+")[0]
    .split(/[.\-_]/)
    .filter(Boolean);
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      // A prerelease part sorts below a numeric one: 1.0.0-beta < 1.0.0.
      if (Number.isInteger(nx)) return 1;
      if (Number.isInteger(ny)) return -1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * A target with an `x` placeholder — `0.9.x`, `26.2.x` — matches on the parts
 * before it and ignores everything after.
 *
 * Worth special-casing rather than folding into the numeric compare: `26.2.x`
 * has to accept a version that simply stops early. Minecraft is `26.2` in the
 * pack, so a naive compare pits `26.2` against a three-part target, reads the
 * missing third part as 0, and reports a conflict on a pack that starts fine.
 */
function wildcardMatch(version, target) {
  const t = parseVersion(target);
  const v = parseVersion(version);
  for (let i = 0; i < t.length; i++) {
    if (/^[xX*]$/.test(t[i])) return true;
    if ((v[i] ?? "0") !== t[i]) return false;
  }
  return true;
}

/** One predicate: `*`, `>=1.2`, `<3`, `~1.2.0`, `^1.2.0`, `1.2.x`, `1.2.3`. */
function satisfiesOne(version, predicate) {
  const p = predicate.trim();
  if (p === "*" || p === "") return true;

  const m = p.match(/^(>=|<=|>|<|\^|~|=)?\s*(.+)$/);
  if (!m) return true;
  const [, op = "=", target] = m;

  if (/[xX*]/.test(target)) {
    // Only equality reads a wildcard as a pattern; `>=1.2.x` is just `>=1.2`.
    if (op === "=") return wildcardMatch(version, target);
    return satisfiesOne(
      version,
      `${op}${target.replace(/[.\-_][xX*].*$/, "")}`,
    );
  }

  const c = compareVersions(version, target);

  switch (op) {
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "=":
      return c === 0;
    case "~": {
      // Same minor, at least the target patch.
      if (c < 0) return false;
      const t = parseVersion(target);
      const v = parseVersion(version);
      return t[0] === v[0] && t[1] === v[1];
    }
    case "^": {
      // Same major, at least the target.
      if (c < 0) return false;
      return parseVersion(target)[0] === parseVersion(version)[0];
    }
    default:
      return true;
  }
}

/**
 * A whole requirement. An array is OR (Fabric's own semantics); a string with
 * spaces is AND, which is how ranges like `>=1.2 <2.0` are written.
 */
function satisfies(version, requirement) {
  if (Array.isArray(requirement)) {
    return requirement.some((r) => satisfies(version, r));
  }
  return String(requirement)
    .split(/\s+/)
    .filter(Boolean)
    .every((p) => satisfiesOne(version, p));
}

// ── NeoForge: Maven version ranges ───────────────────────────
//
// NeoForge does not use semver predicates. `versionRange` in
// `neoforge.mods.toml` is a Maven range:
//
//   [21,)          21 or newer
//   [1.21.1,1.22)  at least 1.21.1, below 1.22
//   (,1.0]         1.0 or older
//   [1.0]          exactly 1.0
//   1.2.3          a *soft* requirement — Maven reads a bare version as a
//                  recommendation, not a floor, and NeoForge follows suit
//
// Comma-separated ranges are OR: `[1.0],[2.0]`.

function satisfiesMavenSingle(version, range) {
  const r = range.trim();
  if (!r) return true;

  // A bare version is a soft requirement: anything satisfies it. Treating it
  // as equality would fail almost every jar that uses this form.
  if (!/^[[(]/.test(r)) return true;

  const m = r.match(/^([[(])\s*([^,\])]*?)\s*(,\s*([^\])]*?)\s*)?([\])])$/);
  if (!m) return true;

  const [, open, lowRaw, comma, highRaw, close] = m;
  const low = lowRaw || "";

  // `[1.0]` — no comma at all means an exact match on that one version.
  if (comma === undefined)
    return low === "" || compareVersions(version, low) === 0;

  if (low !== "") {
    const c = compareVersions(version, low);
    if (open === "[" ? c < 0 : c <= 0) return false;
  }
  if (highRaw !== undefined && highRaw !== "") {
    const c = compareVersions(version, highRaw);
    if (close === "]" ? c > 0 : c >= 0) return false;
  }
  return true;
}

/** Split on commas that separate whole ranges, not the one inside a range. */
function satisfiesMaven(version, range) {
  const parts = [];
  let depth = 0;
  let buf = "";
  for (const ch of String(range)) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  const real = parts.filter((p) => p.trim());
  // An absent or blank `versionRange` means "any version" — it is how a mod
  // says it needs another mod present without caring which build. Leaving it
  // to `[].some()` would read as "nothing satisfies it" and fail every such
  // dependency.
  if (real.length === 0) return true;
  return real.some((p) => satisfiesMavenSingle(version, p));
}

/** One dependency, whichever loader declared it. */
function satisfiesDep(version, dep) {
  return dep.maven
    ? satisfiesMaven(version, dep.range)
    : satisfies(version, dep.range);
}

// ── NeoForge: a small TOML reader ────────────────────────────
//
// Deliberately not a general TOML parser — this repo ships no dependencies, and
// `neoforge.mods.toml` only ever uses a narrow slice of the format: top-level
// key/value pairs, `[[mods]]`, and `[[dependencies.<modid>]]`. Anything richer
// is ignored rather than guessed at.

function parseModsToml(text) {
  const root = { mods: [], dependencies: {} };
  let table = root;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // A `#` inside a quoted value is not a comment.
    let inStr = null;
    let cut = -1;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (inStr) {
        if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") {
        inStr = ch;
      } else if (ch === "#") {
        cut = j;
        break;
      }
    }
    if (cut >= 0) line = line.slice(0, cut);
    line = line.trim();
    if (!line) continue;

    const arrayTable = line.match(/^\[\[\s*([^\]]+?)\s*\]\]$/);
    if (arrayTable) {
      const key = arrayTable[1];
      if (key === "mods") {
        table = {};
        root.mods.push(table);
      } else if (key.startsWith("dependencies.")) {
        const owner = key
          .slice("dependencies.".length)
          .replace(/^["']|["']$/g, "");
        table = {};
        (root.dependencies[owner] ??= []).push(table);
      } else {
        // A table we do not model — swallow its keys instead of leaking them
        // into whatever table came before it.
        table = {};
      }
      continue;
    }
    if (/^\[[^[]/.test(line)) {
      table = {};
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();

    // Multi-line strings, used for `description`. A stray delimiter would
    // otherwise swallow every key that follows it.
    const multi = raw.match(/^('{3}|"{3})/);
    if (multi) {
      const delim = multi[1];
      let body = raw.slice(delim.length);
      while (!body.includes(delim) && i + 1 < lines.length)
        body += "\n" + lines[++i];
      table[key] = body.split(delim)[0];
      continue;
    }

    if (/^["']/.test(raw)) {
      table[key] = raw.slice(1, raw.lastIndexOf(raw[0]));
    } else if (raw === "true" || raw === "false") {
      table[key] = raw === "true";
    } else {
      table[key] = raw;
    }
  }

  return root;
}

// ── Reading jars ─────────────────────────────────────────────

async function unzipEntry(jar, entry) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", jar, entry], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.length ? stdout.toString("utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Jars bundled inside this one. Fabric puts them in `META-INF/jars/`, NeoForge
 * in `META-INF/jarjar/`; ask for both rather than branching on the loader,
 * because a multiloader jar can carry either.
 */
async function listNestedJars(jar) {
  try {
    const { stdout } = await execFileAsync(
      "unzip",
      ["-Z1", jar, "META-INF/jars/*.jar", "META-INF/jarjar/*.jar"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return stdout.split("\n").filter((l) => l.endsWith(".jar"));
  } catch {
    return [];
  }
}

/** `fabric.mod.json` tolerates comments and trailing commas in the wild. */
function parseModJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(
        text
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "")
          .replace(/,(\s*[}\]])/g, "$1"),
      );
    } catch {
      return null;
    }
  }
}

/**
 * The jar on disk, downloaded if this is the first time.
 *
 * Deliberately `fetchFile` rather than a private cache: it keys on the sha1
 * the lockfile already records, so this shares `.cache/downloads` with
 * `build.mjs` — the directory CI already caches — and verifies the hash on the
 * way in. A second cache would double both the download and the CI cache size
 * for no benefit.
 */
async function download(file) {
  await fetchFile(file.url, { sha1: file.sha1 });
  return path.join(CACHE, file.sha1);
}

/**
 * NeoForge lets a mod write `version="${file.jarVersion}"` in its TOML and have
 * the loader substitute the real number from the jar manifest at runtime. Half
 * the libraries in a tech pack do exactly that, and reading the placeholder as
 * a version makes every dependency on them compare against nothing.
 */
async function manifestVersion(jarPath) {
  const mf = await unzipEntry(jarPath, "META-INF/MANIFEST.MF");
  if (!mf) return null;
  // Manifests wrap long lines with a leading space; unfold before matching.
  const line = mf
    .replace(/\r?\n /g, "")
    .match(/^Implementation-Version:\s*(.+)$/m);
  return line ? line[1].trim() : null;
}

function fabricMeta(fabric) {
  const deps = [];
  for (const [id, range] of Object.entries(fabric.depends ?? {})) {
    deps.push({ id, range, maven: false, required: true });
  }
  for (const [id, range] of Object.entries(fabric.breaks ?? {})) {
    deps.push({ id, range, maven: false, required: true, conflict: true });
  }
  return {
    id: fabric.id,
    version: String(fabric.version ?? "0"),
    provides: fabric.provides ?? [],
    deps,
  };
}

async function neoforgeMeta(toml, jarPath) {
  const mod = toml.mods[0];
  if (!mod?.modId) return null;

  const deps = [];
  for (const entry of toml.dependencies[mod.modId] ?? []) {
    if (!entry.modId) continue;
    // Forge's original key was `mandatory = true|false`; NeoForge replaced it
    // with `type`. Jars in the wild still ship the old one — SodiumOptionsAPI
    // does — and reading a `mandatory = false` as required would invent a
    // dependency the pack does not have.
    const type =
      entry.type !== undefined
        ? String(entry.type).toLowerCase()
        : entry.mandatory === false
          ? "optional"
          : "required";
    if (type === "discouraged") continue;
    deps.push({
      id: entry.modId,
      range: entry.versionRange ?? "",
      maven: true,
      required: type === "required",
      conflict: type === "incompatible",
    });
  }

  let version = String(mod.version ?? "0");
  if (/\$\{/.test(version)) version = (await manifestVersion(jarPath)) ?? "0";

  return { id: mod.modId, version, provides: [], deps };
}

/**
 * Read one jar's mod metadata and normalise it.
 *
 * `preferred` is the pack's loader family. It matters: a multiloader jar ships
 * `fabric.mod.json` *and* `neoforge.mods.toml` side by side — Collective,
 * FallingTree, WorldEdit and Starter Kit all do — and reading the wrong one on
 * a NeoForge pack reports `fabricloader` as a missing dependency of a mod that
 * is running perfectly well.
 *
 * Each dep is `{ id, range, maven, required, conflict }`. `maven: true` marks a
 * NeoForge range so `satisfiesDep` picks the right grammar. `required: false`
 * covers Fabric's `recommends` and NeoForge's `optional`, reported only when
 * present *and* wrong, never as missing. `conflict: true` covers NeoForge's
 * `incompatible` and Fabric's `breaks`: satisfying the range is the failure.
 */
async function readModMeta(jarPath, preferred = "fabric") {
  const wantsToml = preferred === "neoforge" || preferred === "forge";

  const readFabric = async () => {
    const raw = await unzipEntry(jarPath, "fabric.mod.json");
    const parsed = raw && parseModJson(raw);
    return parsed?.id ? fabricMeta(parsed) : null;
  };
  const readToml = async () => {
    // NeoForge 1.20.5+ renamed the file; older jars still ship `mods.toml`.
    const raw =
      (await unzipEntry(jarPath, "META-INF/neoforge.mods.toml")) ??
      (await unzipEntry(jarPath, "META-INF/mods.toml"));
    return raw ? neoforgeMeta(parseModsToml(raw), jarPath) : null;
  };

  return wantsToml
    ? ((await readToml()) ?? (await readFabric()))
    : ((await readFabric()) ?? (await readToml()));
}

/**
 * Every mod id a jar puts on the classpath: its own, whatever it `provides`,
 * and the same again for each jar nested inside it.
 */
async function collectProvided(jarPath, into, preferred, depth = 0) {
  const meta = await readModMeta(jarPath, preferred);
  if (!meta) return null;

  into.set(meta.id, meta.version);
  for (const p of meta.provides) {
    if (!into.has(p)) into.set(p, meta.version);
  }

  if (depth < 3) {
    for (const nested of await listNestedJars(jarPath)) {
      const tmp = path.join(
        CACHE,
        "nested",
        `${path.basename(jarPath)}!${path.basename(nested)}`,
      );
      await fs.mkdir(path.dirname(tmp), { recursive: true });
      const bytes = await execFileAsync("unzip", ["-p", jarPath, nested], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      }).catch(() => null);
      if (!bytes) continue;
      await fs.writeFile(tmp, bytes.stdout);
      await collectProvided(tmp, into, preferred, depth + 1);
      await fs.rm(tmp, { force: true });
    }
  }
  return meta;
}

/**
 * Every class name a jar carries, its nested jars included on request.
 *
 * Listing reads the central directory only, so a 40 MB mod costs single-digit
 * milliseconds. Nested jars are the expensive part — they have to be written
 * out before they can be listed — so they are a second pass, taken only when
 * the first one leaves something unresolved.
 *
 * Inner classes arrive already in the shape a script asks for them:
 * `LedgerEntry$Kind` is a real entry, `LedgerEntry\$Kind.class`.
 */
async function collectClasses(jarPath, into, { nested = false, depth = 0 } = {}) {
  const { stdout } = await execFileAsync("unzip", ["-Z1", jarPath, "*.class"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).catch(() => ({ stdout: "" }));

  for (const line of stdout.split("\n")) {
    if (!line.endsWith(".class")) continue;
    into.add(line.slice(0, -".class".length).replace(/\//g, "."));
  }

  if (!nested || depth >= 3) return;
  for (const jar of await listNestedJars(jarPath)) {
    const tmp = path.join(
      CACHE,
      "nested",
      `${path.basename(jarPath)}!${path.basename(jar)}`,
    );
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    const bytes = await execFileAsync("unzip", ["-p", jarPath, jar], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).catch(() => null);
    if (!bytes) continue;
    await fs.writeFile(tmp, bytes.stdout);
    await collectClasses(tmp, into, { nested, depth: depth + 1 });
    await fs.rm(tmp, { force: true });
  }
}

/**
 * Classes that exist at runtime but ship in no mod jar: the game itself, the
 * libraries Minecraft bundles, and the JDK. Nothing here can be checked from
 * the pack's own files, so these are counted and reported rather than failed.
 */
const RUNTIME_PACKAGES = [
  "net.minecraft.",
  "com.mojang.",
  "java.",
  "javax.",
  "jdk.",
  "sun.",
];

/**
 * Which jars a script may reach for, by the directory it sits in. KubeJS runs
 * `server_scripts` on the server, `client_scripts` on the client and
 * `startup_scripts` on both — so a startup script naming a server-only class
 * is broken on the client, and the side a script runs on is part of the test.
 */
const SCRIPT_SIDES = {
  server_scripts: ["server"],
  client_scripts: ["client"],
  startup_scripts: ["server", "client"],
};

/** `Java.loadClass('...')` call sites, with the line each one is on. */
function loadClassRefs(src) {
  const found = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/Java\.loadClass\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
      found.push({ line: i + 1, className: m[2] });
    }
  }
  return found;
}

/**
 * The mod id the loader itself answers to, and the file each jar is read from.
 * Getting this wrong is the failure mode this script exists to prevent: seed
 * `fabricloader` into a NeoForge pack and every jar's `neoforge` dependency
 * reads as missing.
 */
const LOADER_ID = {
  fabric: "fabricloader",
  quilt: "quilt_loader",
  forge: "forge",
  neoforge: "neoforge",
};

/**
 * Every class a KubeJS script loads has to exist in a jar the pack ships.
 *
 * This is the gate that was missing when the pack shipped dead milestone
 * payouts. `milestones.js` asks for
 * `net.whiteravens.ravencoin.economy.LedgerEntry$Kind`; the locked RavenCoin
 * jar predated the ledger and had 56 classes, none of them that one. KubeJS
 * answered with "Class could not be found!", the whole script failed to load,
 * and because the failure is a script that never runs rather than an exception
 * at a call site, nothing downstream said a word: advancements still granted,
 * toasts still appeared, and no balance ever moved. It survived every check in
 * this repo and was found by reading a boot log.
 *
 * Nothing about it was specific to our own mod. `Java.loadClass` is how these
 * scripts reach into OPAC, LuckPerms and Henny Essentials too, and a class
 * renamed in any of them lands exactly the same way on the next bump: silent,
 * and only in the one feature that mod carried.
 *
 * So the test is the whole set, not RavenCoin: take every `Java.loadClass`
 * call site in the pack's scripts and resolve it against the classes actually
 * present in the locked jars for the side that script runs on.
 */
async function checkScriptClasses(slug, jars) {
  const dir = path.join(PACKS_DIR, slug, "server-overrides", "kubejs");
  let files;
  try {
    files = await listFiles(dir);
  } catch {
    return 0;
  }

  const scripts = files.filter((f) => f.relative.endsWith(".js"));
  const refs = [];
  for (const file of scripts) {
    const side = SCRIPT_SIDES[file.relative.split("/")[0]];
    const src = await fs.readFile(file.absolute, "utf8");
    for (const ref of loadClassRefs(src)) {
      refs.push({ ...ref, file: file.relative, side });
    }
  }
  if (!refs.length) return 0;

  // Unknown directory before anything else: resolving its scripts against the
  // wrong side would answer confidently and wrongly.
  const stray = refs.filter((r) => !r.side);
  for (const r of stray) {
    bad(
      `kubejs/${r.file}:${r.line} sits in a directory this check does not know — ` +
        `expected one of ${Object.keys(SCRIPT_SIDES).join(", ")}`,
    );
  }
  if (stray.length) return stray.length;

  const runtime = refs.filter((r) =>
    RUNTIME_PACKAGES.some((pkg) => r.className.startsWith(pkg)),
  );
  const checkable = refs.filter((r) => !runtime.includes(r));

  const bySide = { server: new Set(), client: new Set() };
  const readSide = async (opts) => {
    for (const { file, jar } of jars) {
      const targets =
        file.side === "both" ? ["server", "client"] : [file.side];
      for (const target of targets) {
        if (!bySide[target]) continue;
        await collectClasses(jar, bySide[target], opts);
      }
    }
  };

  await readSide({ nested: false });
  const resolves = (r) => r.side.every((side) => bySide[side].has(r.className));

  // Nested jars are only worth unpacking if something is still missing —
  // normally nothing is, and this second pass never runs.
  let unresolved = checkable.filter((r) => !resolves(r));
  if (unresolved.length) {
    bySide.server.clear();
    bySide.client.clear();
    await readSide({ nested: true });
    unresolved = checkable.filter((r) => !resolves(r));
  }

  for (const r of unresolved) {
    const where = r.side.join(" and ");
    bad(
      `kubejs/${r.file}:${r.line} loads '${r.className}', which no ${where} jar in the pack provides — ` +
        `KubeJS fails the whole script at load, silently`,
    );
  }

  if (!unresolved.length) {
    ok(
      `${checkable.length} class(es) loaded by ${scripts.length} KubeJS script(s) exist in the locked jars`,
    );
  }
  if (runtime.length) {
    dim(
      `${runtime.length} reference(s) to game or JDK classes not checked — they ship in no mod jar`,
    );
  }
  return unresolved.length;
}

async function checkPack(slug) {
  const lock = JSON.parse(
    await fs.readFile(path.join(PACKS_DIR, slug, "pack.lock.json"), "utf8"),
  );
  const pack = JSON.parse(
    await fs.readFile(path.join(PACKS_DIR, slug, "pack.json"), "utf8"),
  );

  console.log(
    `\n\x1b[1m\x1b[36m${pack.name}\x1b[0m v${pack.version}`,
  );

  const loaderType = pack.loader.type;
  const loaderId = LOADER_ID[loaderType];
  if (!loaderId) throw new Error(`Loader "${loaderType}" is not handled here`);

  const metaFile =
    loaderType === "fabric" || loaderType === "quilt"
      ? "fabric.mod.json"
      : "neoforge.mods.toml";

  const mods = lock.files.filter((f) => f.kind === "mod");
  dim(`${mods.length} mods — reading ${metaFile} from each jar`);

  const provided = new Map([
    ["minecraft", pack.minecraft],
    [loaderId, pack.loader.version],
    ["java", "25"],
  ]);
  const metas = [];
  const jars = [];
  let unreadable = 0;

  for (const f of mods) {
    const jar = await download(f);
    jars.push({ file: f, jar });
    const meta = await collectProvided(jar, provided, loaderType);
    if (!meta) {
      warn(`${f.name}: no readable mod metadata — skipped`);
      unreadable++;
      continue;
    }
    metas.push({ file: f, meta, jar });
  }

  // A jar or two without readable metadata is normal — a library, a resource
  // bundle. Every jar unreadable means this script is looking for the wrong
  // file, and reporting "dependencies resolve" then would be a lie.
  if (mods.length && !metas.length) {
    bad(
      `no metadata read from any of ${mods.length} jars — expected ${metaFile}. This check proved nothing.`,
    );
    return mods.length;
  }

  // ── Version predicates ─────────────────────────────────────
  const problems = [];
  const advisory = [];
  const missing = [];

  for (const { file, meta } of metas) {
    for (const dep of meta.deps) {
      const have = provided.get(dep.id);

      if (dep.conflict) {
        if (have !== undefined && satisfiesDep(have, dep)) {
          problems.push({
            mod: meta.id,
            name: file.name,
            dep: dep.id,
            req: `NOT ${dep.range}`,
            have,
            breaking: true,
          });
        }
        continue;
      }

      if (have === undefined) {
        // Client-only mods legitimately miss server-side ids and vice versa;
        // only a *required* dependency absent from the whole pack is worth
        // reporting. An optional one being absent is the normal case.
        if (dep.required) {
          missing.push({
            mod: meta.id,
            name: file.name,
            dep: dep.id,
            req: dep.range,
          });
        }
        continue;
      }

      if (!satisfiesDep(have, dep)) {
        // A mod-vs-mod mismatch is the failure this script was written for:
        // Waystones wanting a newer Balm crashed a shipped pack. A mismatch
        // against `minecraft` is a different animal: in the wild it is usually
        // the metadata that is wrong, not the pack. Every
        // one of JEI's 191 NeoForge builds tagged for 1.21.1 declares
        // `minecraft "[1.21, 1.21.1)"`, which by Maven rules excludes 1.21.1 —
        // yet JEI plainly runs there. Exactly how NeoForge reconciles that is
        // not something this script can observe, so it says so and moves on
        // rather than failing a pack that works.
        //
        // The loader's own range stays a hard failure on purpose: "JEI needs
        // neoforge >= 21.1.238" is precise, actionable, and the fix is to pin
        // a newer loader in pack.json.
        const target = dep.id === "minecraft" ? advisory : problems;
        target.push({
          mod: meta.id,
          name: file.name,
          dep: dep.id,
          req: dep.range,
          have,
        });
      }
    }
  }

  for (const p of problems) {
    bad(
      `${p.name} (${p.mod}) ${p.breaking ? "breaks" : "requires"} ${p.dep} ${JSON.stringify(p.req)} — pack has ${p.have}`,
    );
  }
  for (const a of advisory) {
    warn(
      `${a.name} (${a.mod}) declares ${a.dep} ${JSON.stringify(a.req)} — pack has ${a.have}. Mod-declared ${a.dep} ranges are unreliable; not treated as a failure.`,
    );
  }
  for (const m of missing) {
    warn(
      `${m.name} (${m.mod}) depends on '${m.dep}' ${JSON.stringify(m.req)} — not in the pack`,
    );
  }

  if (unreadable) dim(`${unreadable} jar(s) carried no mod metadata`);
  if (!problems.length) ok(`no version conflicts across ${metas.length} mods`);
  if (!missing.length && !problems.length)
    ok("every declared dependency is present");

  return problems.length + (await checkScriptClasses(slug, jars));
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const slugs = args.length
  ? args
  : (await fs.readdir(PACKS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

let failures = 0;
for (const slug of slugs) failures += await checkPack(slug);

console.log("");
if (failures) {
  console.log(
    `\x1b[31m✗ ${failures} problem(s) — the mod loader would refuse to start, or a script would fail to load\x1b[0m`,
  );
  process.exit(1);
}
console.log("\x1b[32m✓ dependencies resolve and every loaded class exists\x1b[0m");
