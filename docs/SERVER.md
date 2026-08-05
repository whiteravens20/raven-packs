# Running a server

Every pack builds a matching server pack from the same definition, so the two
can't drift apart. Download `<pack>-<version>-server.zip` from
[Releases](https://github.com/whiteravens20/raven-packs/releases).

> **Does this pack even need a server pack?**
> Not always. A pure client pack — performance and UI mods — runs against a
> plain vanilla or Fabric server; players just need the client pack. Check
> `dist/<slug>/pack.json` → `counts.server`. If it's 0, no server pack is built
> and you don't need one. Tech packs are the opposite: their mods are required
> on both sides, and a client will be rejected at login if the server is missing
> them.

---

## Setup

1. **Unzip into an empty directory** on the host.

2. **Install the right Java.** The required version is baked into the pack and
   the start script refuses to run on anything older:

   ```
   Minecraft 26.2 needs Java 25, but 'java' is version 17.0.20.
   Install a newer JDK (https://adoptium.net/) or point JAVA_HOME at one.
   ```

   The requirement moves between Minecraft releases — 1.20 wanted Java 17, 26.2
   wants 25 — so read `SERVER-INSTALL.txt` rather than assuming.

3. **Run the start script.** `./start.sh` on Linux/macOS, `start.bat` on Windows.

4. **Accept the EULA.** The first run stops and tells you to create `eula.txt`
   containing `eula=true`. The build deliberately does not pre-accept it — that
   agreement is yours to make with Mojang, not a build script's.

5. **Run it again.** Fabric downloads the Minecraft server and its libraries on
   first launch. Give it a few minutes and keep it online.

Open **25565/tcp** for players to connect.

---

## What's in the archive

```
mods/                    server-side mods only
config/                  shared config from overrides/
server.properties        from server-overrides/
fabric-server-launch.jar bundled — no separate Fabric install needed
start.sh / start.bat     with Java and EULA checks
SERVER-INSTALL.txt
```

Client-only mods are **absent by design**. Shipping Sodium or a minimap to a
server wastes memory at best and fails to load at worst.

---

## Keeping client and server in sync

Both packs come from one `pack.json` and one lockfile, so a given release pairs
exactly. When you update:

1. Publish the new release (both zips and the manifest are built together).
2. Update the server first, then let players sync.

Raven Forge players just press **Sync**. Everyone else re-imports the `.mrpack`
or re-extracts the client zip.

Mismatches are only fatal for mods required on both sides. A player running an
extra client-only mod is fine; a player missing a `both` mod is not, and will be
disconnected with a mod-list mismatch.

---

## RAM

The start scripts allocate 4–8 GB depending on the pack's `recommendedRamMb`.
Edit `start.sh` / `start.bat` to change it.

Resist going much higher. Oversized heaps make garbage-collection pauses longer,
and players feel those as lag spikes far more than they feel a smaller cache. 6 GB
with the bundled G1GC flags beats 16 GB without them for most servers.

---

## Troubleshooting

**`UnsupportedClassVersionError`** — Java too old. The start script normally
catches this; you'll only see it if you launched the jar directly.

**Players get "mod list mismatch" on join** — the server and client packs are
different versions, or a `both` mod is missing on one side. Compare
`dist/<slug>/pack.json` against what's actually in `mods/`.

**Server starts, then exits immediately** — check `logs/latest.log`. Usually a
mod needing a dependency that isn't installed; `lock.mjs` prevents this for
packs built here, but not for jars added to `mods/` by hand.

**Changes to `server.properties` keep reverting** — the server rewrites the file
on shutdown. Stop the server before editing it.
