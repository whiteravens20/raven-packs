# Raven Packs

Minecraft modpacks maintained by [White Ravens](https://github.com/whiteravens20).

One pack definition, published four ways — so a pack works in
[Raven Forge](https://github.com/whiteravens20/raven-forge), in any third-party
launcher, with no launcher at all, or on a server.

| Output | For | Contains |
|---|---|---|
| `manifest.json` | Raven Forge | Mod list with direct URLs + SHA-512, optionally Ed25519-signed |
| `<pack>-<version>.mrpack` | Prism, ATLauncher, MultiMC, Modrinth App | Download references (small, ~5 KB) |
| `<pack>-<version>.zip` | Manual install, no launcher | Client jars plus configs |
| `<pack>-<version>-server.zip` | Server operators | Server jars, `server.properties`, Fabric launcher, start scripts |
| `<pack>-resources-<version>.zip` | Every client that joins the server | The guide book's text, pushed by the server rather than installed by a launcher |

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

| Pack | Minecraft | Loader | Contents |
|---|---|---|---|
| [White Ravens Classic](packs/ravenclassic/) | 26.2 | Fabric 0.19.3 | 65 mods and 2 shader packs — 44 files reach the client, 41 the server |

White Ravens Classic is **beta**: it runs a live server now, and Minecraft 26.2
is new enough that a few of its mods are still pinned to beta builds.
Its server half is a whole server setup rather than a mod list — a LuckPerms
rank ladder wired to playtime, land claims with per-rank chunk limits, shops,
moderation tooling and an in-game guide book. The operator handbook rides in
the server zip under `dokumentacja/`.

---

## Installing a pack

See **[docs/INSTALL.md](docs/INSTALL.md)** for the player-facing guide. Short version:

**Raven Forge** — new profile → *Play on the White Ravens servers*, and pick the
pack. The launcher reads the catalogue and does the rest. Pasting the manifest URL
by hand still works and comes to the same thing:

```
https://whiteravens20.github.io/raven-packs/ravenclassic/manifest.json
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
  "slug": "ravenclassic",
  "name": "White Ravens Classic",
  "version": "1.2.0",
  "minecraft": "26.2",
  "loader": { "type": "fabric", "version": "0.19.3" },
  "mods": [
    { "slug": "sodium" },                        // newest stable release
    { "slug": "iris", "version": "1.11.2+26.2-fabric" },  // pinned
    { "slug": "luckperms", "side": "server" },   // server zip only
    { "slug": "jei", "allowPrerelease": true },  // no stable 26.2 build yet
    { "url": "https://example.com/private.jar", "name": "Private Mod", "version": "1.0" }
  ]
}
```

Then:

```bash
node scripts/lock.mjs ravenclassic    # resolve → pack.lock.json (the only online step)
node scripts/build.mjs ravenclassic   # offline: manifest + .mrpack in milliseconds
git add packs/ravenclassic/           # commit the definition and the lockfile
```

No `npm install` needed — the toolchain is dependency-free and runs on stock
Node 22+.

Full authoring guide: **[docs/AUTHORING.md](docs/AUTHORING.md)**.

### The lockfile

`packs/<slug>/pack.lock.json` is committed and holds the resolved state: exact
versions, filenames, CDN URLs, sizes and hashes. It is this repo's equivalent of
packwiz's `index.toml`, and it is what keeps large packs cheap:

White Ravens Classic, 66 locked files:

| | |
|---|---|
| Committed to git | 66 KB — 7.4 KB of definition, 59 KB of lockfile |
| `build.mjs`, cold | 0.2 s, Node startup included |
| Network calls at build | 0 |
| Published `.mrpack` | 17 KB |
| Jars it resolves to | 48.5 MiB, none of them in this repo |

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
git switch dev  && git merge --ff-only main && git push
```

The second line is not decoration. `git merge` on `main` writes a merge commit
that `dev` has never seen, so a sync that stops after the first line leaves
`dev` reporting itself behind `main` — and the branches drift a little further
apart with every release, until the next sync is a real merge with a real
chance of conflict over files neither branch actually changed.

**A tag then cuts a GitHub Release for one pack** — after the sync above, never
instead of it:

```bash
git tag ravenclassic-v1.2.0 && git push --tags
```

The slug in the tag picks the pack, and the version must match that pack's
`pack.json` — CI refuses the tag otherwise, because `pack.json` is what names
the built `.mrpack` and a `v1.2.0` release containing `ravenclassic-1.2.1.mrpack`
helps nobody.

**The tag publishes nothing to the site.** GitHub's `github-pages` environment
accepts deployments from `main` alone, so a tag run that tried to deploy was
rejected and turned the whole run red *after* the release had already been
created. It no longer tries: `deploy-pages` is skipped unless the ref is `main`.
Nothing is lost by that, because the commit being tagged is already on `main`
and its own push republished the site seconds earlier.

The consequence is the ordering. **Push to `main` first, tag second.** A tag on
a commit `main` has not seen produces a Release nobody can install through the
launcher, which reads the manifest from Pages and never from a release asset.

Either way CI validates, builds and **signs every manifest** — the job fails
without `PACK_SIGNING_KEY` rather than publishing an unsigned one. The `main`
path deploys `dist/` to GitHub Pages, which is what gives each pack its stable
manifest URL; the tag path adds the `.mrpack`, the client zip, the server zip
and the server's resource pack as release assets, for the tagged pack only.

That last asset is load-bearing rather than convenient. The `server.properties`
inside the server zip points at it by release URL and requires it, so a server
built from a tag that was never pushed serves a 404 and turns away every player.
It is the one output where deleting a release breaks something already running.

The two outputs differ in scope on purpose:

| | Trigger | Contents |
|---|---|---|
| **GitHub Pages** | push to `main` | Every pack, plus `site/` |
| **GitHub Release** | tag `<slug>-v<version>` | The tagged pack's artifacts |

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
