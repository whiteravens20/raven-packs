#!/usr/bin/env node
/**
 * Resolve a pack definition into its lockfile.
 *
 *   node scripts/lock.mjs                # every pack
 *   node scripts/lock.mjs ravenclassic        # one pack
 *   node scripts/lock.mjs ravenclassic --update   # re-resolve unpinned entries too
 *
 * This is the *only* script that talks to Modrinth. Everything downstream —
 * building, validating, publishing — reads `pack.lock.json` and stays offline.
 *
 * Without `--update`, entries already in the lockfile are left exactly as they
 * are, so adding one mod does not silently bump the other ninety-nine.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProject,
  resolveVersion,
  findMissingDependencies,
} from "./lib/modrinth.mjs";
import { fetchFile } from "./lib/download.mjs";
import {
  readLockfile,
  writeLockfile,
  entryKey,
  LOCKFILE_VERSION,
} from "./lib/lockfile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKS_DIR = path.join(ROOT, "packs");

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const keep = (msg) => console.log(`  \x1b[90m·\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);

/**
 * Decide which pack(s) a mod belongs in.
 *
 * Modrinth publishes `client_side`/`server_side` as required/optional/
 * unsupported. "unsupported" on one side is a hard signal; anything else means
 * the mod loads on both, so `both` is the safe default — an extra optional mod
 * on a server wastes a little RAM, whereas a missing one that the client
 * expects desynchronises the mod list and blocks login.
 *
 * Authors override with `"side"` in pack.json when they know better (a minimap
 * marked server-optional has no business in a server pack).
 */
function inferSide(project, override) {
  if (override) return override;
  if (project.serverSide === "unsupported") return "client";
  if (project.clientSide === "unsupported") return "server";
  return "both";
}

/**
 * The Java major version Mojang ships this Minecraft release against.
 *
 * Worth recording rather than guessing: the requirement moves (26.2 needs 25,
 * 1.20.x needed 17) and getting it wrong means server admins meet an
 * UnsupportedClassVersionError stack trace instead of a sentence telling them
 * which JDK to install.
 */
async function getRequiredJava(mcVersion) {
  const ua = { "User-Agent": "whiteravens20/raven-packs" };
  try {
    const manifest = await (
      await fetch(
        "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
        {
          headers: ua,
          signal: AbortSignal.timeout(15000),
        },
      )
    ).json();

    const entry = manifest.versions.find((v) => v.id === mcVersion);
    if (!entry) return null;

    const meta = await (
      await fetch(entry.url, {
        headers: ua,
        signal: AbortSignal.timeout(15000),
      })
    ).json();
    return meta.javaVersion?.majorVersion ?? null;
  } catch {
    return null;
  }
}

/** Resolve the Fabric server launcher so the server pack can be turnkey. */
async function getServerLauncher(pack) {
  if (pack.loader.type !== "fabric") return null;

  const installers = await (
    await fetch("https://meta.fabricmc.net/v2/versions/installer", {
      headers: { "User-Agent": "whiteravens20/raven-packs" },
      signal: AbortSignal.timeout(15000),
    })
  ).json();

  const installer = installers.find((i) => i.stable) ?? installers[0];
  if (!installer) return null;

  return {
    installerVersion: installer.version,
    url: `https://meta.fabricmc.net/v2/versions/loader/${pack.minecraft}/${pack.loader.version}/${installer.version}/server/jar`,
    fileName: "fabric-server-launch.jar",
  };
}

async function readPack(slug) {
  const file = path.join(PACKS_DIR, slug, "pack.json");
  const pack = JSON.parse(await fs.readFile(file, "utf8"));
  if (pack.slug !== slug) {
    throw new Error(
      `${slug}/pack.json declares slug "${pack.slug}" — must match its directory`,
    );
  }
  pack.mods ??= [];
  pack.resourcePacks ??= [];
  pack.shaders ??= [];
  return pack;
}

/** Resolve one definition entry to a locked file record. */
async function lockEntry(entry, kind, pack) {
  const key = entryKey(entry);

  if (entry.url) {
    // Nothing to ask an API about — hash the bytes so integrity still holds.
    const file = await fetchFile(entry.url);
    const fileName =
      entry.filename ?? path.basename(new URL(entry.url).pathname);
    // Nothing to infer from — a direct URL carries no side metadata.
    const side = entry.side ?? (kind === "mod" ? "both" : "client");
    ok(`${entry.name ?? fileName} (direct url, ${side})`);
    return {
      requestKey: key,
      kind,
      side,
      id: entry.id ?? fileName.replace(/\.(jar|zip)$/i, ""),
      name: entry.name ?? fileName,
      source: "url",
      version: entry.version ?? "unknown",
      fileName,
      url: entry.url,
      size: file.size,
      sha1: file.sha1,
      sha512: file.sha512,
      sha256: file.sha256,
      license: "unknown",
      requiredDependencies: [],
    };
  }

  const project = await getProject(entry.slug);
  const version = await resolveVersion(entry.slug, {
    mcVersion: pack.minecraft,
    loader: pack.loader.type,
    pin: entry.version,
    allowPrerelease: entry.allowPrerelease ?? false,
  });

  // Resource packs and shaders are client-side by definition.
  const side =
    kind === "mod" ? inferSide(project, entry.side) : (entry.side ?? "client");

  // Resolved to project ids so the entry can name a dependency by slug.
  const ignoredDeps = new Set();
  for (const ignored of entry.ignoreDependencies ?? []) {
    const p = await getProject(ignored).catch(() => null);
    if (p) ignoredDeps.add(p.id);
    else
      warn(
        `${key}: ignoreDependencies lists "${ignored}", which is not on Modrinth`,
      );
  }

  const notes = [
    entry.version ? "pinned" : null,
    version.usedPrerelease ? `\x1b[33m${version.versionType}\x1b[0m` : null,
    entry.side ? `side: ${side} (forced)` : `side: ${side}`,
  ].filter(Boolean);
  ok(`${project.title} ${version.versionNumber} (${notes.join(", ")})`);

  return {
    requestKey: key,
    kind,
    side,
    clientSide: project.clientSide,
    serverSide: project.serverSide,
    id: project.slug,
    name: project.title,
    source: "modrinth",
    projectId: project.id,
    versionId: version.versionId,
    version: version.versionNumber,
    fileName: version.file.filename,
    url: version.file.url,
    size: version.file.size,
    sha1: version.file.sha1,
    // Modrinth publishes sha1 + sha512, never sha256. Recording sha512 is what
    // lets the whole pipeline avoid downloading jars.
    sha512: version.file.sha512,
    license: project.license,
    requiredDependencies: (version.dependencies ?? [])
      .filter((d) => d.dependency_type === "required" && d.project_id)
      .map((d) => d.project_id)
      // A multiloader project publishes one version entry for every loader it
      // supports, and Modrinth's dependency list has no per-loader granularity.
      // LambDynamicLights tags one release fabric+neoforge+quilt and lists
      // fabric-api as required — true on Fabric, false on NeoForge, where its
      // implementation rides along in META-INF/jars. `ignoreDependencies` is
      // the pack author saying so out loud, in a line a reviewer can see.
      .filter((id) => !ignoredDeps.has(id)),
  };
}

async function lockPack(slug, { update }) {
  const pack = await readPack(slug);
  // An outdated lockfile is exactly what this script exists to replace.
  const existing = await readLockfile(PACKS_DIR, slug, {
    outdatedIsNull: true,
  });

  console.log(
    `\n\x1b[1m\x1b[36m${pack.name}\x1b[0m v${pack.version} — Minecraft ${pack.minecraft}, ` +
      `${pack.loader.type} ${pack.loader.version}${update ? " \x1b[33m(updating)\x1b[0m" : ""}`,
  );

  // A Minecraft or loader change invalidates every resolved version.
  const packChanged =
    existing &&
    (existing.pack.minecraft !== pack.minecraft ||
      existing.pack.loader?.type !== pack.loader.type);
  if (packChanged) {
    console.log(
      "  \x1b[33mMinecraft/loader changed — re-resolving everything\x1b[0m",
    );
  }

  const previous = new Map(
    packChanged || update
      ? []
      : (existing?.files ?? []).map((f) => [f.requestKey, f]),
  );

  const entries = [
    ...pack.mods.map((e) => ["mod", e]),
    ...pack.resourcePacks.map((e) => ["resourcepack", e]),
    ...pack.shaders.map((e) => ["shader", e]),
  ];

  const files = [];
  const failures = [];

  for (const [kind, entry] of entries) {
    const cached = previous.get(entryKey(entry));
    if (cached) {
      keep(`${cached.name} ${cached.version} (locked)`);
      files.push(cached);
      continue;
    }
    try {
      files.push(await lockEntry(entry, kind, pack));
    } catch (err) {
      // Keep going: with a large pack you want the full list of what needs
      // attention, not whichever entry happened to fail first.
      console.log(
        `  \x1b[31m✗\x1b[0m ${entry.slug ?? entry.url} — ${err.message}`,
      );
      failures.push({ label: entry.slug ?? entry.url, message: err.message });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${entries.length} entries could not be resolved:\n` +
        failures.map((f) => `    - ${f.label}: ${f.message}`).join("\n"),
    );
  }

  // Dependency completeness is checked here, where we have the API data, and
  // recorded so offline builds can re-check without network access.
  const included = new Set(files.map((f) => f.projectId).filter(Boolean));
  const missing = await findMissingDependencies(
    files
      .filter((f) => f.source === "modrinth")
      .map((f) => ({
        project: { id: f.projectId, slug: f.id },
        version: {
          dependencies: f.requiredDependencies.map((id) => ({
            project_id: id,
            dependency_type: "required",
          })),
        },
      })),
  );
  const stillMissing = missing.filter((d) => !included.has(d.projectId));

  if (stillMissing.length > 0) {
    for (const dep of stillMissing) {
      warn(
        `missing required dependency: ${dep.title} (${dep.slug}) — needed by ${dep.requiredBy.join(", ")}`,
      );
    }
    throw new Error(
      `${stillMissing.length} required dependencies are not in the pack. Add to packs/${slug}/pack.json: ` +
        stillMissing.map((d) => `{ "slug": "${d.slug}" }`).join(", "),
    );
  }

  const serverLauncher = await getServerLauncher(pack);
  const requiredJava = await getRequiredJava(pack.minecraft);
  if (requiredJava)
    ok(`Minecraft ${pack.minecraft} requires Java ${requiredJava}`);
  else
    warn(
      `could not determine the Java version for Minecraft ${pack.minecraft}`,
    );

  const lock = {
    lockfileVersion: LOCKFILE_VERSION,
    pack: {
      slug: pack.slug,
      name: pack.name,
      version: pack.version,
      minecraft: pack.minecraft,
      loader: pack.loader,
      requiredJava,
      serverLauncher,
    },
    generatedAt: new Date().toISOString(),
    files,
  };

  await writeLockfile(PACKS_DIR, slug, lock);

  const clientCount = files.filter(
    (f) => f.side === "client" || f.side === "both",
  ).length;
  const serverCount = files.filter(
    (f) => f.side === "server" || f.side === "both",
  ).length;
  const changed = files.filter((f) => !previous.has(f.requestKey)).length;

  console.log(
    `  \x1b[1m→ pack.lock.json: ${files.length} files` +
      `${changed ? `, ${changed} resolved` : ", no changes"}\x1b[0m`,
  );
  console.log(`     client pack: ${clientCount} · server pack: ${serverCount}`);

  if (serverCount === 0) {
    warn("no server-side content — this pack runs against a plain server");
  }
  return lock;
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update") || args.includes("-u");
  const requested = args.filter((a) => !a.startsWith("-"));

  const slugs = requested.length
    ? requested
    : (await fs.readdir(PACKS_DIR, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

  for (const slug of slugs) await lockPack(slug, { update });

  console.log("\n\x1b[32m✓ lockfiles up to date — commit them\x1b[0m");
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
