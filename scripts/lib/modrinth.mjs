/**
 * Modrinth API client — no dependencies, no API key required.
 *
 * https://docs.modrinth.com/api/
 */

const API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'whiteravens20/raven-packs (https://github.com/whiteravens20/raven-packs)';

/** Modrinth asks for <300 requests/min; this keeps us comfortably under. */
const MIN_REQUEST_INTERVAL_MS = 120;
let lastRequestAt = 0;

async function apiFetch(path) {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const res = await fetch(`${API}${path}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });

  if (res.status === 404) {
    throw new Error(`Not found on Modrinth: ${path}`);
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 10);
    console.warn(`  rate limited, waiting ${retryAfter}s…`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return apiFetch(path);
  }
  if (!res.ok) {
    throw new Error(`Modrinth API ${res.status} for ${path}`);
  }
  return res.json();
}

export async function getProject(slug) {
  const p = await apiFetch(`/project/${slug}`);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    projectType: p.project_type,
    clientSide: p.client_side,
    serverSide: p.server_side,
    license: p.license?.id ?? 'unknown',
  };
}

/**
 * Pick the version of a project to ship.
 *
 * With `pin` set, matches `version_number` first and the opaque version `id`
 * second, so a pack can pin either. Without it, takes the newest *stable*
 * release for the target Minecraft version and loader — Modrinth returns
 * versions newest-first. Prereleases are only used when a project has published
 * nothing else, and the caller is told so it can be surfaced in the build log.
 */
export async function resolveVersion(slug, { mcVersion, loader, pin, allowPrerelease = false }) {
  const query = new URLSearchParams({
    game_versions: JSON.stringify([mcVersion]),
    loaders: JSON.stringify([loader]),
  });

  let versions = await apiFetch(`/project/${slug}/version?${query}`);

  // Resource packs and shaders are not tagged with a mod loader; retry unfiltered.
  if (versions.length === 0) {
    versions = (await apiFetch(`/project/${slug}/version`)).filter((v) =>
      v.game_versions.includes(mcVersion),
    );
  }

  if (versions.length === 0) {
    throw new Error(`${slug}: no release for Minecraft ${mcVersion} (${loader})`);
  }

  let chosen;
  let usedPrerelease = false;

  if (pin) {
    chosen = versions.find((v) => v.version_number === pin || v.id === pin);
    if (!chosen) {
      const available = versions.slice(0, 5).map((v) => v.version_number).join(', ');
      throw new Error(`${slug}: pinned version "${pin}" not found. Recent: ${available}`);
    }
    usedPrerelease = chosen.version_type !== 'release';
  } else {
    chosen = allowPrerelease ? versions[0] : versions.find((v) => v.version_type === 'release');
    if (!chosen) {
      // Nothing stable for this Minecraft version yet — ship the newest
      // prerelease rather than failing, but make the build say so.
      chosen = versions[0];
      usedPrerelease = true;
    }
  }

  const file = chosen.files.find((f) => f.primary) ?? chosen.files[0];
  if (!file) throw new Error(`${slug}: version ${chosen.version_number} has no downloadable file`);

  return {
    versionId: chosen.id,
    versionNumber: chosen.version_number,
    versionType: chosen.version_type,
    usedPrerelease,
    name: chosen.name,
    datePublished: chosen.date_published,
    dependencies: chosen.dependencies ?? [],
    file: {
      url: file.url,
      filename: file.filename,
      size: file.size,
      sha1: file.hashes?.sha1,
      sha512: file.hashes?.sha512,
    },
  };
}

/**
 * Report required dependencies that the pack does not itself include.
 *
 * Deliberately reports rather than auto-adds: a curated pack should list every
 * jar it ships, and silently pulling in transitive mods is how packs drift.
 */
export async function findMissingDependencies(resolved) {
  const includedProjectIds = new Set(resolved.map((r) => r.project.id));
  const missing = new Map();

  for (const entry of resolved) {
    for (const dep of entry.version.dependencies) {
      if (dep.dependency_type !== 'required') continue;
      if (!dep.project_id || includedProjectIds.has(dep.project_id)) continue;

      if (!missing.has(dep.project_id)) {
        const project = await getProject(dep.project_id).catch(() => null);
        missing.set(dep.project_id, {
          projectId: dep.project_id,
          slug: project?.slug ?? dep.project_id,
          title: project?.title ?? dep.project_id,
          requiredBy: [],
        });
      }
      missing.get(dep.project_id).requiredBy.push(entry.project.slug);
    }
  }

  return [...missing.values()];
}
