# Security Policy — Raven Packs

This repository publishes **manifests**. A manifest tells
[Raven Forge](https://github.com/whiteravens20/raven-forge) which files to
download and put in a player's `mods/` folder, and Minecraft mods are arbitrary
Java running with that player's privileges. Nothing here executes on its own —
and everything here decides what executes somewhere else.

---

## Reporting a Vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's [private vulnerability reporting](https://github.com/whiteravens20/raven-packs/security/advisories/new)
for this repository. It reaches the maintainer and stays private until a fix
ships.

Please include the pack slug and version, what an attacker gains and what they
need in order to try it, and reproduction steps. If it involves a published
manifest, quote its URL and the exact bytes you are worried about.

| Stage | Target |
|---|---|
| Acknowledgement | 72 hours |
| Initial assessment | 7 days |
| Fix or documented mitigation | 30 days for high/critical |

This is a solo, unpaid project. There is no bug bounty.

---

## Supported Versions

Only the currently published version of each pack is maintained. Older tags are
historical artefacts — they are not patched, and a manifest from one stays
signed and valid forever (see [Known Gaps](#known-gaps)).

---

## Security Model

### What is in the repository

- **No mod jars, ever.** The repo stores references — a URL, a size and a hash —
  resolved from Modrinth and frozen in `packs/<slug>/pack.lock.json`. There is no
  binary in git history to be swapped.
- **No keys.** `keys/` is gitignored and the Ed25519 private key exists only on
  the maintainer's machine and as the `PACK_SIGNING_KEY` repository secret. It is
  never an argument, never a file in CI, never in a log line.

### Integrity of a published manifest

- **Every manifest is signed**, in CI, with Ed25519. The publish job **fails**
  when `PACK_SIGNING_KEY` is absent rather than shipping an unsigned manifest —
  the one failure mode worth being loud about, because an unsigned manifest still
  installs mods.
- The signature covers a canonical JSON form of the entire manifest with keys
  sorted **recursively**. `scripts/lib/canonical.mjs` and the launcher's
  `src/core/updater/canonical.ts` must stay **byte-identical**; a divergence in
  either does not fail loudly, it just makes every signature stop matching.
- **Every file entry carries a hash** — `sha512` straight from Modrinth for
  Modrinth entries, `sha256` computed at build time for direct-URL entries. The
  launcher deletes a file whose hash does not match and fails the sync; it is
  never installed anyway.
- **Builds are offline.** The lockfile already holds every URL and hash, so a
  build resolves nothing and cannot quietly pick up a file that was not reviewed.
  `validate.mjs` fails a `pack.json` edited without re-locking.

### Write access

- No pull requests and no branches: changes land on `dev` from the maintainer,
  and `main` — the branch GitHub Pages publishes — is synced by hand. Branch
  protection requires an owner review that an outside PR will not receive.
- Publishing has exactly two triggers: a push to `main`, which republishes the
  site, and a `<slug>-v*` tag, which adds a GitHub Release for that pack. Both
  need push access to this repository — there is no path from a fork.

---

## Known Gaps

Listed on purpose. An honest list beats a clean-looking one.

- **The launcher's feeds are not signed.** `site/raven-forge/*.json` supplies the
  news and announcement cards shown inside Raven Forge, and nothing verifies
  them. Whoever can write to `main` controls those headlines, article bodies and
  links. The launcher parses the bodies into elements rather than HTML, so the
  exposure is social — a convincing "download this" link — not script injection.
- **No revocation and no expiry.** A signed manifest is valid forever. Anyone who
  can serve an old one at a manifest URL can pin players to an older mod set;
  there is no rollback protection and no way to withdraw a signature.
- **A signature proves origin, not safety.** It says "White Ravens published
  this", not "this is safe to run". A mod that is exactly the file the manifest
  named can still be malicious, abandoned, or vulnerable.
- **Trust rests on key distribution.** A player who never adds the public key
  under Settings → Trusted Keys gets hash checking only, which protects against a
  corrupted download but not against a manifest host that lies consistently.
- **Upstream is trusted at lock time.** Hashes are recorded from what Modrinth
  served when the pack was locked. A compromised upstream release that predates
  the lock is locked in, hash and all.

---

## Out of Scope

Reports on the following will be closed without a fix:

| Not a vulnerability here | Where it belongs |
|---|---|
| A vulnerability in a mod this pack ships | That mod's author; the repo distributes a reference, not their code |
| A vulnerability in Modrinth, GitHub Pages, Minecraft or a launcher | Their respective vendors |
| A pack you forked and edited, or a manifest you signed yourself | Your key, your manifest |
| "The manifest lets you install mods" | That is the product |
| Automated scanner output with no demonstrated impact | Send the analysis, not the report |
