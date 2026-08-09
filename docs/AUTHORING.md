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

## Client and server sides

Each entry gets a `side` — `client`, `server` or `both` — which decides where it
ships. Omit it and it is inferred from Modrinth's `client_side`/`server_side`:
`unsupported` on one side pins it to the other, otherwise `both`.

Set it explicitly when the inference is wrong, which is common — Modrinth marks
plenty of client UI mods as server-*optional*:

```jsonc
{ "slug": "jade", "side": "client", "reason": "HUD overlay; nothing for a server to do" }
{ "slug": "spark", "side": "server" }
{ "slug": "lithium" }                  // inferred "both" — correct
```

`lock.mjs` prints the resolved side for every entry and a per-pack summary, so
review it after locking.

The split is enforced everywhere: the launcher manifest and `.mrpack` omit
`server`-only entries, and the server zip omits `client`-only ones. A client
never downloads `server.properties`, and a server never gets a minimap.

## Overrides

Three directories, mirroring the `.mrpack` layout. Paths are relative to the
instance root.

| Directory | Ships to |
|---|---|
| `overrides/` | both packs |
| `client-overrides/` | client pack only |
| `server-overrides/` | server pack only |

```
packs/ravenclassic/
├── overrides/config/sodium.json   → both
├── client-overrides/options.txt   → client only
└── server-overrides/server.properties → server only
```

Each format carries them differently — the launcher manifest as `configFiles[]`
(fetched from the published URL, hash-verified), the `.mrpack` under
`overrides/`, and the zips at the archive root.

> Overrides **overwrite** the player's file on every sync. Only ship files the
> pack genuinely needs to own. Shipping `options.txt` resets a returning
> player's video settings — consider a mod like YOSBR that applies defaults only
> on first run.

### server-resourcepack/

A fourth directory, and not an override at all: it is a resource pack the
**server** hands to every client that joins.

```
packs/ravenclassic/server-resourcepack/
├── pack.mcmeta
└── assets/ravenclassic/lang/pl_pl.json
```

`build.mjs` zips it, hashes it, publishes it as a release asset and writes the
URL, the sha1 and `require-resource-pack=true` into the `server.properties`
that goes out in the server zip. Nothing else has to be configured, and
anything already written for those keys is replaced — a hand-edited hash that
disagrees with the shipped archive does not fail a build, it fails every
player's login on a server that is by then already live.

Use it for client-side content the **server** owns, and the guide book is the
example that forced it into existence. Modonomicon books are data-driven, so
the book itself is a datapack the server syncs to whoever joins — but the text
it renders is a translation file, and translation files only exist client-side.
Shipped as a client override it reached players who arrived through Raven Forge
and nobody else, so anyone on Prism read the guide as raw translation keys. Sent
by the server it reaches everyone, and it ships from the same build as the book,
so the two cannot drift.

The URL points at the release asset rather than the copy on Pages, deliberately.
Release assets never change, so a server still running last month's pack keeps
serving the exact file its own `server.properties` was hashed against. A Pages
URL would have every new release rewrite the bytes underneath it, and a hash
that no longer matches locks out every player on a server that requires the pack.

The consequence is that the release has to exist. A server zip built by hand,
outside CI, carries a placeholder URL and the build says so — start a server
from one and nobody can join.

### pack.mcmeta

A resource pack or data pack shipped in the overrides declares which game it is
for, and current Minecraft wants `min_format`/`max_format` — not the older
`pack_format`/`supported_formats`, which it refuses to read once a pack claims
support past resource format 64 or data format 81:

```json
{ "pack": { "description": "…", "min_format": 88, "max_format": 88 } }
```

A bare integer is `<major>.0` in `min_format` and `<major>.*` in `max_format`,
so one major number covers every point release of that Minecraft version.

The numbers are not guessable and differ between the two pack kinds. Read them
from `version.json` inside the client jar for the version you target —
`pack_version.resource_major` for resource packs, `pack_version.data_major` for
data packs. Minecraft 26.2 is 88 and 107.

Getting this wrong fails quietly in the worst place: the build passes, the sync
passes, and the player finds the pack listed as incompatible and switched off.
`validate.mjs` checks the shape, but only you can check the numbers.

## The lockfile

`packs/<slug>/pack.lock.json` is committed and records the *resolved* state:
exact versions, filenames, CDN URLs, sizes and hashes. `pack.json` says what you
want; the lockfile says what you got.

This is what keeps big packs cheap. Mod jars are never committed — the 67-file
White Ravens Classic is 68 KB of git — and because every URL and hash is already
recorded, `build.mjs` runs entirely offline in a fifth of a second.

Only `lock.mjs` talks to Modrinth. Always commit `pack.json` and `pack.lock.json`
together.

## Workflow

```bash
# 1. edit packs/ravenclassic/pack.json
# 2. resolve — the only step that needs network
node scripts/lock.mjs ravenclassic

# 3. build — offline, milliseconds
node scripts/build.mjs ravenclassic

# 4. commit both files together
git add packs/ravenclassic/
```

Inspect what you built before tagging:

```bash
head -40 dist/ravenclassic/pack.json                    # resolved versions and licenses
node scripts/build.mjs ravenclassic --with-zip          # bundle jars, then:
unzip -l dist/ravenclassic/ravenclassic-1.1.0.zip       # what manual installers get
```

`--with-zip` is the only thing that downloads jars. CI passes it for releases;
skip it locally unless you are testing the launcher-free install path.

### Updating mods

Locking is **conservative**: entries already in the lockfile are kept as they
are, so adding one mod never bumps the other ninety-nine.

```bash
node scripts/lock.mjs ravenclassic            # resolve only new/changed entries
node scripts/lock.mjs ravenclassic --update   # re-resolve everything unpinned
git diff packs/ravenclassic/pack.lock.json    # review exactly what moved
```

Changing `minecraft` or `loader.type` re-resolves everything automatically —
versions from the old target are meaningless.

Bump the pack's own `version` whenever the resolved set changes, then tag:

```bash
git tag ravenclassic-v1.1.0 && git push --tags
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
node scripts/build.mjs ravenclassic
node scripts/sign.mjs dist/ravenclassic/manifest.json keys/ravenpacks.key
```

The signature covers the canonical form of the manifest — object keys sorted at
every level, `signature` itself excluded. That canonicalization is duplicated in
`scripts/lib/canonical.mjs` here and in `manifest-verify.ts` in raven-forge, and
the two must stay byte-identical. If you change one, change both, and re-run the
cross-check in that repo.
