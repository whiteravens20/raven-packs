# Authoring a pack

## Adding a pack

```bash
mkdir -p packs/<slug>/overrides
$EDITOR packs/<slug>/pack.json
```

The directory name and the `slug` field must match — the build refuses to
continue otherwise, since the slug becomes part of the published manifest URL.

## `pack.json`

| Field | Required | Notes |
|---|---|---|
| `slug` | yes | Matches the directory name. Appears in URLs and filenames. |
| `name` | yes | Display name. Becomes `serverName` in the launcher manifest. |
| `version` | yes | Semver. Bump on every release; it names the artifacts. |
| `summary` | no | One-line description. |
| `minecraft` | yes | Exact Minecraft version, e.g. `26.2`. |
| `loader.type` | yes | `fabric`, `quilt`, `forge` or `neoforge`. |
| `loader.version` | yes | Pin it — an unpinned loader makes builds irreproducible. |
| `recommendedRamMb` | no | Shown to players. Defaults to 4096. |
| `server` | no | `{ ip, port }` for the launcher's Quick-Connect button. |
| `mods` | no | See below. |
| `resourcePacks` | no | Same shape as `mods`. |
| `shaders` | no | Same shape as `mods`. |

> Raven Forge can only install **Fabric** and **Quilt** today. A `forge` or
> `neoforge` pack still builds a valid `.mrpack` and client zip, but the
> launcher will refuse to install its loader.

## Entries

**From Modrinth** — the normal case:

```jsonc
{ "slug": "sodium" }                                   // newest stable release
{ "slug": "sodium", "version": "mc26.2-0.9.1-fabric" } // pinned
{ "slug": "sodium", "allowPrerelease": true }          // opt into alpha/beta
```

`version` matches Modrinth's `version_number` first and its opaque version `id`
second, so either works.

**From a URL** — for anything Modrinth does not host:

```jsonc
{
  "url": "https://files.example.net/mods/raven-rules-1.0.0.jar",
  "name": "Raven Server Rules",
  "version": "1.0.0",
  "id": "raven-rules"
}
```

The build hashes whatever it downloads, so URL entries are just as
integrity-checked as Modrinth ones — but the URL must stay reachable, because
that is what players fetch from.

**`reason`** is ignored by the build. Use it: in six months it is the only
record of why a mod is in the list.

## Overrides

Anything under `packs/<slug>/overrides/` is shipped with the pack, with paths
relative to `.minecraft`:

```
packs/ravenmc/overrides/
├── options.txt              → .minecraft/options.txt
└── config/sodium.json       → .minecraft/config/sodium.json
```

Each format carries them differently — the launcher manifest as
`configFiles[]` (fetched from the published URL, hash-verified), the `.mrpack`
under `overrides/`, and the client zip at the archive root.

> Overrides **overwrite** the player's file on every sync. Only ship files the
> pack genuinely needs to own. Shipping `options.txt` resets a returning
> player's video settings — consider a mod like YOSBR that applies defaults only
> on first run.

## The lockfile

`packs/<slug>/pack.lock.json` is committed and records the *resolved* state:
exact versions, filenames, CDN URLs, sizes and hashes. `pack.json` says what you
want; the lockfile says what you got.

This is what keeps big packs cheap. Mod jars are never committed — an 81-mod pack
is 68 KB of git — and because every URL and hash is already recorded, `build.mjs`
runs entirely offline in well under a second.

Only `lock.mjs` talks to Modrinth. Always commit `pack.json` and `pack.lock.json`
together.

## Workflow

```bash
# 1. edit packs/ravenmc/pack.json
# 2. resolve — the only step that needs network
node scripts/lock.mjs ravenmc

# 3. build — offline, milliseconds
node scripts/build.mjs ravenmc

# 4. commit both files together
git add packs/ravenmc/
```

Inspect what you built before tagging:

```bash
head -40 dist/ravenmc/pack.json              # resolved versions and licenses
node scripts/build.mjs ravenmc --with-zip    # bundle jars, then:
unzip -l dist/ravenmc/ravenmc-1.0.0.zip      # what manual installers get
```

`--with-zip` is the only thing that downloads jars. CI passes it for releases;
skip it locally unless you are testing the launcher-free install path.

### Updating mods

Locking is **conservative**: entries already in the lockfile are kept as they
are, so adding one mod never bumps the other ninety-nine.

```bash
node scripts/lock.mjs ravenmc            # resolve only new/changed entries
node scripts/lock.mjs ravenmc --update   # re-resolve everything unpinned
git diff packs/ravenmc/pack.lock.json    # review exactly what moved
```

Changing `minecraft` or `loader.type` re-resolves everything automatically —
versions from the old target are meaningless.

Bump the pack's own `version` whenever the resolved set changes, then tag:

```bash
git tag ravenmc-v1.1.0 && git push --tags
```

### When locking fails

Failures are collected and reported together, so one run tells you everything
that needs attention rather than stopping at the first problem.

**"required dependencies are not in the pack"** — a mod needs something you did
not list. The message tells you exactly what to paste into `pack.json`. Do not
work around it; a pack that relies on another launcher's dependency resolution
will break on the manual-install path.

**"no release for Minecraft X"** — the mod has not updated yet. Wait, drop it, or
pin an older Minecraft version for the whole pack. Expect a lot of these right
after a Minecraft release: large tech mods routinely lag by months.

**"Not found on Modrinth"** — wrong slug, or the mod is CurseForge-only. Use the
slug from the project's Modrinth URL; for CurseForge-only mods, host the jar
yourself and add it as a `url` entry.

**"pinned version not found"** — the author pulled or renamed that version. The
error lists recent versions to pick from.

### When the build fails

**"pack.json and pack.lock.json disagree"** — you edited the definition without
re-locking. Run `node scripts/lock.mjs <slug>` and commit both.

## Signing

```bash
node scripts/keygen.mjs ravenpacks      # once; keys/ is gitignored
node scripts/build.mjs ravenmc
node scripts/sign.mjs dist/ravenmc/manifest.json keys/ravenpacks.key
```

The signature covers the canonical form of the manifest — object keys sorted at
every level, `signature` itself excluded. That canonicalization is duplicated in
`scripts/lib/canonical.mjs` here and in `manifest-verify.ts` in raven-forge, and
the two must stay byte-identical. If you change one, change both, and re-run the
cross-check in that repo.
