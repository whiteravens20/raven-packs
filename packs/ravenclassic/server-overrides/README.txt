White Ravens Classic — server
=============================

The pack has unpacked the configs here that can be prepared up front. The rest —
groups, permissions, claim limits — lives in the LuckPerms database and in configs
the mods only generate on first start. That will not go into a zip, so it is
written down in the files next to this one.

    docs/ranks.txt     the rank ladder and the full set of LuckPerms commands
    docs/claims.txt    claims, chunk loading, what is protected
    docs/shops.txt     player shops and admin shops
    docs/staff.txt     WorldEdit, moderation, vanish, logs

Read ranks.txt first. Everything else follows from it.


Order of the first start
------------------------

1. Start the server and let it reach "Done". Do not let anyone in yet.
   The mods are generating their configs now — only after this step do the
   files named below exist at all.

2. Stop the server (/stop). Never edit configs while the server is running —
   on the way down it overwrites your changes with its own copy from memory.

3. Check that what came with the pack survived the first start:

       world/serverconfig/openpartiesandclaims-server.toml
       config/luckperms/luckperms.conf
       config/EssentialCommands.properties
       config/styled-chat.json
       world/config/playtime-rewards/config.json

   The files will grow by the keys they were missing — that is normal. What
   matters is that the values the pack set are still there.

4. Start the server and work through docs/ranks.txt from top to bottom.
   It is one block of commands to paste into the console.

5. Pregenerate the world. Without it the first weeks are lag on every trip
   outside spawn:

       /chunky radius 3000
       /chunky start

6. Hook up backups. The pack carries no backup mod — the host makes them.
   Check that a copy is actually being written and that it can be restored,
   before you let players in, not after the first grief.

7. Whitelist and players, and not before.


Signing in
----------

The server runs in offline mode and EasyAuth is what holds the name: a player
registers a password and the server binds it to their name.

    /register <password> <password>
    /login <password>

`/auth` is an administrative command, not a player one: `/auth register <name>
<password>` creates an account for somebody, `/auth remove <name>` deletes it.
A player changes their own password with `/account changePassword <old> <new>`.

EasyAuth is a condition here, not an addition. Without it, offline mode means
anyone can walk in on somebody else's name — do not drop it from the pack.


The in-game guide
-----------------

The Modonomicon book is carried by a datapack unpacked together with the world:

    world/datapacks/ravenclassic-guide/

The text itself travels separately, in the resource pack the server hands out:
the address and sha1 are in server.properties (`resource-pack`,
`resource-pack-sha1`), and `require-resource-pack=true` makes it a condition of
entry. That is why it also reaches players who arrived on a launcher other than
Raven Forge.

If the pages show raw keys instead of sentences, the player refused the resource
pack or the server is handing out an address with nothing behind it. The book
loaded fine — it is the text that is missing.

If the pages are entirely blank while the nodes draw normally, somebody moved
the directory layout. Modonomicon looks for pages at
`entries/<category>/<entry>/pages/` and checks that middle part against the
book's categories; a directory named after a category that no longer exists cuts
off every page inside it without a word in the server log.
`node scripts/validate.mjs` in the pack repository catches this.

A third thing that looks like a fault and is not: after the client changes
language, category names and titles switch over immediately while the page
content stays in the old one. Modonomicon renders content once, during recipe
sync on join, and bakes the result; titles are translated components redrawn
every frame. Leaving the server and coming back is enough — F3+T and /reload
will not touch it.

Corrected guide text does not arrive on its own. It is a new zip with a new
release, so after each one you have to swap `resource-pack` and
`resource-pack-sha1` in server.properties (both are ready in the server.zip from
that release) and restart the server. `resource-pack-id` stays the same
deliberately: it is how the client knows this is the same pack in a new version
rather than a second one beside it.


Blocked recipes
---------------

    world/datapacks/ravenclassic-rules/

This datapack does two things. It cuts the waystone recipes with a "filter"
section in pack.mcmeta, and it hands out the starter kit after death and on
`/trigger rc_kit` (docs/staff.txt, section 5). It needs
`function-permission-level=4` in server.properties — without it the functions
have no right to call `/starterkit give`. Sharestones, portstones and scrolls
are still craftable; they are what builds the network around the stones you have
to earn.

Where a waystone comes from, then. Three ways: find one in a village, get one as
the reward for the Obywatel rank (Playtime Rewards hands it out once, see
docs/ranks.txt), or buy one in the admin shop. A recipe cannot be made to depend
on a rank — on Fabric 26.2 there is no mod that asks LuckPerms at the crafting
table — so the gate is the item, not the recipe. It comes out the same, and it
works today.

Want to block something else? Add another entry to the "block" list: namespace
is the mod, path is a regular expression matching the file path inside that mod.

After the start check both datapacks:

    /datapack list

Both declare data format 107, the one 26.2 wants (the number is in version.json
inside the client jar, field pack_version.data_major). If either lands on the
disabled list after a Minecraft version change, that is the only number to fix —
and the only symptom, because the server start will not protest.
