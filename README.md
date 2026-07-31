# Raven Packs

Minecraft modpacks maintained by [White Ravens](https://github.com/whiteravens20).

One pack definition, published three ways — so a pack works in
[Raven Forge](https://github.com/whiteravens20/raven-forge), in any third-party
launcher, or with no launcher at all.

| Output | For | Contains |
|---|---|---|
| `manifest.json` | Raven Forge | Mod list with SHA-256 hashes, optionally Ed25519-signed |
| `<pack>-<version>.mrpack` | Prism, ATLauncher, MultiMC, Modrinth App | Download references (small, ~5 KB) |
| `<pack>-<version>.zip` | Manual install, no launcher | The actual jars plus configs (~30 MB) |

---

## Packs

| Pack | Minecraft | Loader | Mods |
|---|---|---|---|
| [Raven MC](packs/ravenmc/) | 26.2 | Fabric 0.19.3 | 25 — performance and quality-of-life, no gameplay changes |

---

## Installing a pack

See **[docs/INSTALL.md](docs/INSTALL.md)** for the player-facing guide. Short version:

**Raven Forge** — create a profile, paste the manifest URL, hit sync:

```
https://whiteravens20.github.io/raven-packs/ravenmc/manifest.json
```

**Any other launcher** — download the `.mrpack` from
[Releases](https://github.com/whiteravens20/raven-packs/releases) and import it.

**No launcher** — install [Fabric](https://fabricmc.net/use/installer), download
the `.zip`, unzip it into `.minecraft`.

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
node scripts/validate.mjs          # check every entry resolves — no downloads
node scripts/build.mjs ravenmc     # build all three outputs into dist/
```

No `npm install` needed — the toolchain is dependency-free and runs on stock
Node 22+.

Full authoring guide: **[docs/AUTHORING.md](docs/AUTHORING.md)**.

### What the build does for you

- Resolves each Modrinth slug to its **newest stable release** for the target
  Minecraft version and loader. Prereleases are only used when a project has
  published nothing else, and the build log says so.
- **Fails if a required dependency is missing.** It reports what to add rather
  than silently pulling in transitive mods, so the pack always lists every jar
  it ships.
- Downloads every jar (cached in `.cache/`), verifies the upstream SHA-1, and
  records SHA-256 for the launcher manifest and SHA-1 + SHA-512 for the `.mrpack`.
- Warns about mods marked client-side `unsupported`.

---

## Releasing

Tag as `<slug>-v<version>`:

```bash
git tag ravenmc-v1.0.0 && git push --tags
```

CI validates, builds, signs the manifest if `PACK_SIGNING_KEY` is set, attaches
the artifacts to a GitHub Release, and deploys `dist/` to GitHub Pages — which
is what gives each pack its stable manifest URL.

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

## Licensing

The tooling and pack definitions in this repository are MIT (see [LICENSE](LICENSE)).

**Mods are not.** Every mod keeps its own license, and no mod jar is committed
here — the build downloads them from Modrinth at build time. Redistributing the
generated `.zip` is only appropriate where the bundled mods' licenses allow it;
each pack's `dist/<slug>/pack.json` lists the license of every mod it includes.
The `.mrpack` distributes references rather than jars, which is the safer format
to hand around.
