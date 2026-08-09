/**
 * Content-addressed download cache.
 *
 * Every jar is fetched once and keyed by its upstream sha1, so repeat builds
 * (and CI runs with a warm cache) do no network I/O. We need the bytes locally
 * anyway: Modrinth publishes sha1/sha512, but the Raven Forge manifest is
 * specified in sha256, so the file has to be hashed here.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE_DIR = path.join(process.cwd(), '.cache', 'downloads');

function hash(buf, algorithm) {
  return crypto.createHash(algorithm).update(buf).digest('hex');
}

async function readCached(key) {
  try {
    return await fs.readFile(path.join(CACHE_DIR, key));
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and return its bytes plus every hash the build needs.
 *
 * @param {string} url
 * @param {{ sha1?: string, sizeHint?: number }} [expected]
 *        When `sha1` is given it is verified after download — a mismatch means
 *        the CDN served something other than what the API described.
 */
export async function fetchFile(url, expected = {}) {
  const key = expected.sha1 ?? hash(Buffer.from(url), 'sha1');

  let data = await readCached(key);
  let cached = data !== null;

  if (!cached) {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    data = Buffer.from(await res.arrayBuffer());

    if (expected.sha1) {
      const actual = hash(data, 'sha1');
      if (actual !== expected.sha1) {
        throw new Error(`sha1 mismatch for ${url}\n  expected ${expected.sha1}\n  got      ${actual}`);
      }
    }

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, key), data);
  }

  return {
    data,
    cached,
    size: data.length,
    sha1: hash(data, 'sha1'),
    sha256: hash(data, 'sha256'),
    sha512: hash(data, 'sha512'),
  };
}

export function sha1(buf) {
  return hash(buf, 'sha1');
}

export function sha256(buf) {
  return hash(buf, 'sha256');
}

/** Recursively list files under `dir` as archive-relative POSIX paths. */
export async function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full, base)));
    } else if (entry.isFile()) {
      out.push({ absolute: full, relative: path.relative(base, full).split(path.sep).join('/') });
    }
  }
  return out;
}
