# Installing a Raven pack

Three ways, easiest first. You only need one.

> Running the server rather than playing on it? See **[SERVER.md](SERVER.md)**.

---

## 1. Raven Forge (recommended)

The launcher keeps the pack up to date on its own — when the pack changes, it
downloads only what actually changed and verifies every file's hash.

1. Install [Raven Forge](https://github.com/whiteravens20/raven-forge/releases).
2. **Profiles → New profile.**
3. Fill in:
   - **Minecraft version** — `26.2`
   - **Mod loader** — Fabric, version `0.19.3`
   - **Manifest URL** — `https://whiteravens20.github.io/raven-packs/ravenmc/manifest.json`
   - **RAM** — 4096 MB or more
4. **Sync** — the launcher downloads the loader, the mods and the configs.
5. **GRAJ.**

Later updates need nothing but pressing Sync again.

### Verifying the pack signature (optional)

If the pack is signed, add the publisher's public key under
**Settings → Trusted Keys**. Manifests that pass verification show a
**Verified** badge; a manifest that has been tampered with is rejected.

---

## 2. Another launcher (Prism, ATLauncher, MultiMC, Modrinth App)

Use the `.mrpack` — the standard Modrinth pack format.

1. Download `ravenmc-<version>.mrpack` from
   [Releases](https://github.com/whiteravens20/raven-packs/releases).
2. Import it:
   - **Prism Launcher** — *Add Instance → Import →* pick the file
   - **Modrinth App** — *Add content → From file*
   - **ATLauncher** — *Add Pack → Import*
   - **MultiMC** — *Add Instance → Import from zip*
3. Launch the instance.

The launcher downloads the mods itself, which is why the file is only a few
kilobytes.

Updating means importing the newer `.mrpack` — most launchers will offer to
update the existing instance.

---

## 3. No launcher at all

Use the plain `.zip`. It contains the actual mod jars, so this works with the
vanilla Minecraft launcher.

1. Install the Fabric loader for Minecraft `26.2`:
   <https://fabricmc.net/use/installer>
   Pick **Client**, choose the right Minecraft version, install.
2. Open the vanilla Minecraft launcher, select the new **fabric-loader** profile,
   press Play once so the game creates its folders, then quit.
3. Download `ravenmc-<version>.zip` from
   [Releases](https://github.com/whiteravens20/raven-packs/releases).
4. Unzip it into your `.minecraft` folder, merging with what is there:

   | OS | Path |
   |---|---|
   | Windows | `%APPDATA%\.minecraft` |
   | Linux | `~/.minecraft` |
   | macOS | `~/Library/Application Support/minecraft` |

   You should end up with `.minecraft/mods/` full of `.jar` files.
5. In the launcher, edit the Fabric profile and give it at least **4 GB** of RAM
   (*More Options → JVM arguments →* change `-Xmx2G` to `-Xmx4G`).
6. Play.

To update, delete everything in `.minecraft/mods/` first, then unzip the new
release — otherwise old and new versions of the same mod will collide and the
game will refuse to start.

> Keeping a separate install: pass `--gameDir` in the profile's *Game directory*
> field to point the pack at its own folder, so it does not mix with your normal
> singleplayer worlds.

---

## Troubleshooting

**The game crashes immediately on launch.**
Almost always duplicate or mismatched mods. Empty `mods/` and re-extract. Confirm
the Fabric loader version matches the pack (`0.19.3` for Raven MC).

**"Incompatible mod set" / a mod names a missing dependency.**
You have a partial install. Every dependency ships with the pack, so a complete
extraction cannot produce this.

**The game runs out of memory or stutters badly.**
Raise the RAM allocation to 4–6 GB. More than 8 GB usually makes things *worse* —
longer garbage-collection pauses.

**Shaders do nothing.**
The pack ships Iris but no shader packs. Drop a `.zip` shader into
`.minecraft/shaderpacks/` and pick it under *Options → Video Settings → Shaders*.
