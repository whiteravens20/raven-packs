#!/usr/bin/env node
/**
 * Resolve the pack's mod dependencies the way Fabric Loader will at startup.
 *
 *   node scripts/check-deps.mjs                # every pack
 *   node scripts/check-deps.mjs ravenclassic   # one pack
 *
 * Why this exists, and why the lockfile is not enough.
 *
 * `lock.mjs` asks Modrinth which projects a version depends on. Modrinth
 * answers with project ids and, for most entries, `version_id: null` — it says
 * *that* Waystones needs Balm, never *which* Balm. The real requirement is a
 * version predicate inside the jar's own `fabric.mod.json`, and nothing that
 * talks to the API can see it.
 *
 * That gap shipped a broken pack: Waystones was bumped to 26.2.0.9, whose
 * project-level dependency list was byte-identical to 26.2.0.7's, so the bump
 * looked clean from the API. The jar wanted `balm >=26.2.0.6` and the pack had
 * 26.2.0.5, and the first person to launch it got a Fabric Loader crash screen
 * instead of a game. This script reads the jars.
 *
 * It also walks nested jars (`META-INF/jars/`), because a mod id can be
 * satisfied by a module bundled inside another mod — most of `fabric-api` is
 * exactly that, and treating those as missing would bury the real failures.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchFile } from "./lib/download.mjs";

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

async function listNestedJars(jar) {
  try {
    const { stdout } = await execFileAsync(
      "unzip",
      ["-Z1", jar, "META-INF/jars/*.jar"],
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
 * Every mod id a jar puts on the classpath: its own, whatever it `provides`,
 * and the same again for each jar nested inside it.
 */
async function collectProvided(jarPath, into, depth = 0) {
  const raw = await unzipEntry(jarPath, "fabric.mod.json");
  const meta = raw && parseModJson(raw);
  if (!meta?.id) return null;

  into.set(meta.id, String(meta.version ?? "0"));
  for (const p of meta.provides ?? []) {
    if (!into.has(p)) into.set(p, String(meta.version ?? "0"));
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
      await collectProvided(tmp, into, depth + 1);
      await fs.rm(tmp, { force: true });
    }
  }
  return meta;
}

async function checkPack(slug) {
  const lock = JSON.parse(
    await fs.readFile(path.join(PACKS_DIR, slug, "pack.lock.json"), "utf8"),
  );
  const pack = JSON.parse(
    await fs.readFile(path.join(PACKS_DIR, slug, "pack.json"), "utf8"),
  );

  console.log(
    `\n\x1b[1m\x1b[36m${lock.pack.name}\x1b[0m v${lock.pack.version}`,
  );

  const mods = lock.files.filter((f) => f.kind === "mod");
  dim(`${mods.length} mods — reading fabric.mod.json from each jar`);

  const provided = new Map([
    ["minecraft", pack.minecraft],
    ["fabricloader", pack.loader.version],
    ["java", "25"],
  ]);
  const metas = [];

  for (const f of mods) {
    const jar = await download(f);
    const meta = await collectProvided(jar, provided);
    if (!meta) {
      warn(`${f.name}: no readable fabric.mod.json — skipped`);
      continue;
    }
    metas.push({ file: f, meta, jar });
  }

  // ── Version predicates ─────────────────────────────────────
  const problems = [];
  const missing = [];

  for (const { file, meta } of metas) {
    for (const [depId, req] of Object.entries(meta.depends ?? {})) {
      const have = provided.get(depId);
      if (have === undefined) {
        // Client-only mods legitimately miss server-side ids and vice versa;
        // only a dependency absent from the whole pack is worth reporting.
        missing.push({ mod: meta.id, name: file.name, dep: depId, req });
        continue;
      }
      if (!satisfies(have, req)) {
        problems.push({ mod: meta.id, name: file.name, dep: depId, req, have });
      }
    }
    for (const [badId, range] of Object.entries(meta.breaks ?? {})) {
      const have = provided.get(badId);
      if (have !== undefined && satisfies(have, range)) {
        problems.push({
          mod: meta.id,
          name: file.name,
          dep: badId,
          req: `NOT ${JSON.stringify(range)}`,
          have,
          breaking: true,
        });
      }
    }
  }

  for (const p of problems) {
    bad(
      `${p.name} (${p.mod}) ${p.breaking ? "breaks" : "requires"} ${p.dep} ${JSON.stringify(p.req)} — pack has ${p.have}`,
    );
  }
  for (const m of missing) {
    warn(
      `${m.name} (${m.mod}) depends on '${m.dep}' ${JSON.stringify(m.req)} — not in the pack`,
    );
  }

  if (!problems.length) ok(`no version conflicts across ${metas.length} mods`);
  if (!missing.length && !problems.length)
    ok("every declared dependency is present");

  return problems.length;
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
    `\x1b[31m✗ ${failures} dependency conflict(s) — Fabric Loader would refuse to start\x1b[0m`,
  );
  process.exit(1);
}
console.log("\x1b[32m✓ dependencies resolve\x1b[0m");
