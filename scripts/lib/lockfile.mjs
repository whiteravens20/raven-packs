/**
 * Lockfile read/write.
 *
 * `packs/<slug>/pack.lock.json` is committed and is the only artifact that
 * records *resolved* state: exact versions, filenames, CDN URLs and hashes.
 * It plays the same role as packwiz's index.toml.
 *
 * Why it exists:
 *   - builds become offline and reproducible — `build.mjs` never calls an API
 *     and never downloads a jar, so a 100-mod pack builds in a second
 *   - a mod update is a reviewable diff instead of an invisible drift
 *   - Modrinth publishes sha1/sha512, so recording sha512 here means nobody ever
 *     has to download a jar purely to compute a hash for the manifest
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const LOCKFILE_VERSION = 1;

export function lockfilePath(packsDir, slug) {
  return path.join(packsDir, slug, 'pack.lock.json');
}

export async function readLockfile(packsDir, slug) {
  try {
    const raw = await fs.readFile(lockfilePath(packsDir, slug), 'utf8');
    const lock = JSON.parse(raw);
    if (lock.lockfileVersion !== LOCKFILE_VERSION) {
      throw new Error(
        `${slug}/pack.lock.json is version ${lock.lockfileVersion}, expected ${LOCKFILE_VERSION} — re-run: node scripts/lock.mjs ${slug}`,
      );
    }
    return lock;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeLockfile(packsDir, slug, lock) {
  await fs.writeFile(lockfilePath(packsDir, slug), `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Identity of a pack.json entry, used to detect definition/lockfile drift.
 * Deliberately excludes `reason`, which is a comment for humans.
 */
function entryKey(entry) {
  return JSON.stringify({
    slug: entry.slug ?? null,
    url: entry.url ?? null,
    version: entry.version ?? null,
    allowPrerelease: entry.allowPrerelease ?? false,
  });
}

/**
 * Compare a pack definition against its lockfile.
 *
 * Reports what the definition asks for that the lock does not cover, and what
 * the lock still carries that the definition dropped.
 */
export function diffLockfile(pack, lock) {
  const defined = [
    ...(pack.mods ?? []).map((e) => ['mod', e]),
    ...(pack.resourcePacks ?? []).map((e) => ['resourcepack', e]),
    ...(pack.shaders ?? []).map((e) => ['shader', e]),
  ];

  const lockedKeys = new Map((lock?.files ?? []).map((f) => [f.requestKey, f]));
  const definedKeys = new Set(defined.map(([, e]) => entryKey(e)));

  const added = defined
    .filter(([, e]) => !lockedKeys.has(entryKey(e)))
    .map(([kind, e]) => ({ kind, label: e.slug ?? e.url }));

  const removed = (lock?.files ?? [])
    .filter((f) => !definedKeys.has(f.requestKey))
    .map((f) => ({ kind: f.kind, label: f.id }));

  const packChanged =
    lock &&
    (lock.pack.minecraft !== pack.minecraft ||
      lock.pack.loader?.type !== pack.loader.type ||
      lock.pack.loader?.version !== pack.loader.version);

  return { added, removed, packChanged, inSync: added.length === 0 && removed.length === 0 && !packChanged };
}

export { entryKey };
