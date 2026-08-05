# Raven Packs

Minecraft modpacks maintained by [White Ravens](https://github.com/whiteravens20).

One pack definition, published three ways — so a pack works in
[Raven Forge](https://github.com/whiteravens20/raven-forge), in any third-party
launcher, or with no launcher at all.

| Output | For | Contains |
|---|---|---|
| `manifest.json` | Raven Forge | Mod list with direct URLs + SHA-512, optionally Ed25519-signed |
| `<pack>-<version>.mrpack` | Prism, ATLauncher, MultiMC, Modrinth App | Download references (small, ~5 KB) |
| `<pack>-<version>.zip` | Manual install, no launcher | Client jars plus configs |
| `<pack>-<version>-server.zip` | Server operators | Server jars, `server.properties`, Fabric launcher, start scripts |

Plus one file for the site as a whole: `packs.json`, a catalogue of every
published pack with its manifest URL. Raven Forge fetches it to offer the packs
as a choice, so a player picks a pack by name instead of pasting an address.

Client and server come from the same definition, so they cannot drift apart. The
client never receives server-only mods or `server.properties`; the server never
receives a minimap. See [docs/SERVER.md](docs/SERVER.md).

Mod jars are never committed — the repo stores references only, so a 100-mod pack
costs about 70 KB of git history. See [the lockfile](#the-lockfile).

---

## Packs

| Pack | Minecraft | Loader | Mods |
|---|---|---|---|
| [Raven MC](packs/ravenmc/) | 26.2 | Fabric 0.19.3 | 25 — performance and quality-of-life, no gameplay changes |

---

## Installing a pack

See **[docs/INSTALL.md](docs/INSTALL.md)** for the player-facing guide. Short version:

**Raven Forge** — new profile → *Play on the White Ravens servers*, and pick the
pack. The launcher reads the catalogue and does the rest. Pasting the manifest URL
by hand still works and comes to the same thing:

```
https://whiteravens20.github.io/raven-packs/ravenmc/manifest.json
```

**Any other launcher** — download the `.mrpack` from
[Releases](https://github.com/whiteravens20/raven-packs/releases) and import it.

**No launcher** — install [Fabric](https://fabricmc.net/use/installer), download
the `.zip`, unzip it into `.minecraft`.

**Running a server** — download the `-server.zip`, unzip, run `start.sh`.
Full guide: **[docs/SERVER.md](docs/SERVER.md)**.

---

## Maintaining a pack

Everything about a pack lives in one hand-edited file, `packs/<slug>/pack.json`:

```jsonc
{
  "slug": "ravenmc",
  "name": "Raven MC",
  "version": "1.0.0",
  "minecraft": "26.2",
  "loader": { "type": "fabric", "version": "0.19.3" },
  "mods": [
    { "slug": "sodium" },                        // newest stable release
    { "slug": "iris", "version": "1.11.2+26.2-fabric" },  // pinned
    { "url": "https://example.com/private.jar", "name": "Private Mod", "version": "1.0" }
  ]
}
```

Then:

```bash
node scripts/lock.mjs ravenmc      # resolve → pack.lock.json (the only online step)
node scripts/build.mjs ravenmc     # offline: manifest + .mrpack in milliseconds
git add packs/ravenmc/            # commit the definition and the lockfile
```

No `npm install` needed — the toolchain is dependency-free and runs on stock
Node 22+.

Full authoring guide: **[docs/AUTHORING.md](docs/AUTHORING.md)**.

### The lockfile

`packs/<slug>/pack.lock.json` is committed and holds the resolved state: exact
versions, filenames, CDN URLs, sizes and hashes. It is this repo's equivalent of
packwiz's `index.toml`, and it is what keeps large packs cheap:

| | 25-mod pack | 81-mod pack |
|---|---|---|
| Committed to git | 24 KB | 68 KB |
| `build.mjs`, cold | 0.11 s | 0.06 s |
| Network calls at build | 0 | 0 |
| Published `.mrpack` | 4.7 KB | 12 KB |
| Mod bytes stored in the repo | 0 | 0 |

**No mod jars are ever committed.** They live on Modrinth's CDN; the repo stores
only references. Builds are offline because the lockfile already records every
URL and hash — verified by running the build with networking disabled.

Because the manifest carries each mod's direct URL and SHA-512, **the launcher
also makes zero API calls** when syncing a pack, and keeps working when Modrinth
is down.

### What the tooling does for you

- `lock.mjs` resolves each Modrinth slug to its **newest stable release** for the
  target Minecraft version and loader. Prereleases are used only when a project
  has published nothing else, and it says so.
- Entries already locked are **left alone** unless you pass `--update`, so adding
  one mod never silently bumps the other ninety-nine.
- **Fails if a required dependency is missing**, listing every one at once rather
  than stopping at the first. It reports what to add instead of silently pulling
  in transitive mods, so the pack always lists every jar it ships.
- `validate.mjs` (offline) fails when a definition was edited without re-locking.
- Warns about mods marked client-side `unsupported` and flags prerelease pins.

---

## Publishing

Two triggers, because the site holds two kinds of content.

**Any push to `main` republishes the site.** That is the whole path for the
launcher's feeds: `site/` is hand-edited prose, and making a news correction or
an announcement wait for a pack release would be absurd. Nothing needs tagging.

```bash
git switch main && git merge dev && git push   # feeds live within a minute or two
```

**A tag additionally cuts a GitHub Release for one pack:**

```bash
git tag ravenmc-v1.0.0 && git push --tags
```

The slug in the tag picks the pack, and the version must match that pack's
`pack.json` — CI refuses the tag otherwise, because `pack.json` is what names
the built `.mrpack` and a `v1.0.0` release containing `ravenmc-1.0.1.mrpack`
helps nobody. Tag a commit on `main` that is current: the build runs on the
tagged tree and `deploy-pages` replaces the whole site, so tagging an old commit
republishes the feeds and every other pack's manifest as they were then.

Either way CI validates, builds and **signs every manifest** — the job fails
without `PACK_SIGNING_KEY` rather than publishing an unsigned one — then deploys
`dist/` to GitHub Pages, which is what gives each pack its stable manifest URL.
The tag path adds the `.mrpack`, the client zip and the server zip as release
assets, for the tagged pack only.

The two outputs differ in scope on purpose:

| | Contents |
|---|---|
| **GitHub Pages** | Every pack, plus `site/` |
| **GitHub Release** | The tagged pack's artifacts |

Pages gets everything because `deploy-pages` replaces the whole site: publishing
one pack's `dist/` alone would take every other pack's manifest offline and
break the launcher for players who are not on the pack being released. That is
also why a pack's manifest goes live from `main`, not from its tag — the tag
decides which pack gets downloadable artifacts, never which packs stay
reachable.

## The launcher's feeds

`site/` is copied into `dist/` verbatim and serves the JSON Raven Forge fetches
that is not pack output:

| URL | Set in the launcher under |
|---|---|
| `…/raven-forge/news.json` | Settings → News feed |
| `…/raven-forge/announcements.json` | Settings → Announcement feed |

Both feeds carry a full `body`, so a card opens as a readable article **inside
the launcher**: a feed needs no website behind it, and `url` is an optional
"open in a browser" link rather than the way in. `body` accepts a small Markdown
subset — `## headings`, `- lists`, `**bold**`, `*italic*`, `` `code` `` and
`[links](https://…)` — which the launcher parses into elements, never into HTML.

Edit them by hand and push to `dev`; the site republishes when `dev` is synced
into `main`, with no tag and no pack release. They are **not signed**, unlike
manifests: whoever can write here controls the headlines and links shown inside
the launcher, so this directory deserves the same care as a manifest.

### Signing

Signed manifests get a "Verified" badge in Raven Forge, and players who trust
your public key are protected against a tampered manifest host.

```bash
node scripts/keygen.mjs ravenpacks         # writes keys/ (gitignored)
gh secret set PACK_SIGNING_KEY < keys/ravenpacks.key
```

Publish `keys/ravenpacks.pub` so players can add it under
**Settings → Trusted Keys**.

---

## Contributing

This is a first-party content repository — the packs here are the ones White
Ravens runs, and a manifest published from it decides which jars land on a
player's machine. **Pull requests are not accepted.** See
[CONTRIBUTING.md](CONTRIBUTING.md) for what to open instead, and
[SECURITY.md](SECURITY.md) for the trust model and how to report a
vulnerability privately.

---

## Licensing

The tooling and pack definitions in this repository are MIT (see [LICENSE](LICENSE)).

**Mods are not.** Every mod keeps its own license, and no mod jar is committed
here — the build downloads them from Modrinth at build time. Redistributing the
generated `.zip` is only appropriate where the bundled mods' licenses allow it;
each pack's `dist/<slug>/pack.json` lists the license of every mod it includes.
The `.mrpack` distributes references rather than jars, which is the safer format
to hand around.
