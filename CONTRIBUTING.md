# Contributing to Raven Packs

Short version: **this repository does not accept pull requests.**

That is not a slight on your patch. A manifest published from here tells
[Raven Forge](https://github.com/whiteravens20/raven-forge) which jars to
download and run on a player's machine, and the launcher trusts it because it
carries an Ed25519 signature made by a key only the maintainer holds. Merging a
change to a pack definition is therefore an act of code distribution, not a
documentation edit, and it is kept to a single reviewed hand on purpose.

---

## What the repository is

The packs here are the ones White Ravens actually runs. There is no
general-purpose "submit your modpack" path — a pack in this repo implies the
maintainer tests it, keeps it locked to working versions, and is on the hook
when it breaks mid-session for everyone on the server.

## How changes land

`dev` is the working branch. `main` is a published snapshot the maintainer syncs
from it, and pushing `main` is what republishes GitHub Pages — the manifest URLs
players' profiles point at.

There are no feature branches and no pull requests, in either direction.
Branch protection enforces it: a PR opened here needs an owner review it will
not get, so it sits until it is closed.

## What to open instead

Issues, and they are read:

| Situation | What helps |
|---|---|
| A mod in a pack crashes or conflicts | The pack slug, its version, the crash report, and which mod you suspect |
| A manifest fails to sync in Raven Forge | The profile's manifest URL and the launcher's error, verbatim |
| A mod is out of date or has a better replacement | The Modrinth link and why it is worth the churn |
| A pack should exist | Describe it — but see above; expect a no unless it is a pack White Ravens will run |
| Something in the docs is wrong | Quote the line; a correction in an issue is merged faster than a PR that cannot be |

Bugs in the **launcher** belong in
[raven-forge](https://github.com/whiteravens20/raven-forge/issues), not here.
Bugs in a **mod** belong with that mod's author — this repo ships references to
their files, not their code.

## Security reports

**Do not open a public issue.** See [SECURITY.md](SECURITY.md).

---

## Maintainer notes

For the person with push access, so the rules are written down rather than
remembered:

- Every pack edit is `lock.mjs` → `build.mjs` → commit **the definition and the
  lockfile together**. `validate.mjs` fails a `pack.json` edited without
  re-locking, which is the whole point of committing the lockfile.
- Commits are Conventional Commits, one topic each, **subject line only**.
- Never commit a mod jar, and never commit `keys/` — the private signing key is
  a repository secret (`PACK_SIGNING_KEY`) and nothing else.
- `scripts/lib/canonical.mjs` is half of a cross-repo contract with Raven
  Forge's `src/core/updater/canonical.ts`. The two must produce **byte-identical**
  output; change one and you have silently invalidated every signature.
- A release is a tag, `<slug>-v<version>`. The publish job fails rather than
  ship an unsigned manifest.
