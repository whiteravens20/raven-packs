// White Ravens Forge — the two reset steps that need a running server.
//
// The mine is wiped by deleting `world/dimensions/ravenforge/mining/` with the
// server down. Two things have to happen before that, and neither of them is a
// file operation:
//
//   1. players standing in the mine have to leave, or they come back inside
//      freshly generated stone;
//   2. player claims have to go, because claim data does NOT live under
//      `world/dimensions/`. It sits in `world/data/openpartiesandclaims/
//      player-claims/<uuid>.nbt`, one file per player with every dimension
//      inside, so deleting the mine leaves the claims behind — and after the
//      reset they protect fresh, random ground that nobody chose.
//
// Open Parties and Claims cannot do the second one. `/oclaims clear` starts
// with `CommandSourceStack.getPlayerOrException()`, so the console is refused
// outright, and clearing someone else's claims additionally needs claims admin
// mode, which is a state on a player. There are exactly three claiming modes —
// player, party, server — and none of them unclaims another player's chunk. So
// the command below goes to OPAC's API instead:
//
//   OpenPACServerAPI.get(server).getServerClaimsManager()
//     .getPlayerInfoStream() -> getDimension(mine) -> ChunkPos -> unclaim(...)
//
// Walking the owners rather than the map regions is deliberate: the owner is
// the thing being decided on, so the server claim is skipped by identity
// instead of by coordinates. `unclaim` itself checks nothing but `claimsEnabled`
// and goes through `DimensionClaimsManager.unclaim(.., playerClaimInfoManager,
// configManager)`, so the owner's claim count and the saved file both follow.
//
// The server claim on the spawn platform is deliberately LEFT ALONE. It is not
// stored in the dimension either, so skipping it here means the platform is
// still protected the moment the mine comes back — no re-claim after restart.
//
// Wrapped in a function because KubeJS runs every server script in one shared
// scope; see the same note in `claim_guard.js`.
(function () {
  const MinePAC = Java.loadClass('xaero.pac.common.server.api.OpenPACServerAPI')
  const MinePlayerConfig = Java.loadClass('xaero.pac.common.server.player.config.PlayerConfig')
  const MineResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation')

  // Defined by the `ravenforge-mining` datapack that ships beside this file.
  const MINE_DIM = 'ravenforge:mining'

  // Every binding inside a loop body below is `var`, and that is not a style
  // choice. Measured on the rig: a `const` or `let` declared inside a loop body
  // binds ONCE in KubeJS's Rhino and is never reassigned, so the loop silently
  // runs on the first element as many times as there are elements — no warning,
  // no error, a wrong answer. Five owners came back as five copies of the first
  // until these were `var`. `let` in the `for` header is fine; the counter does
  // advance. The streams are drained with `toList()` for the same reason: an
  // `iterator()` walk hits the identical trap on the loop variable.
  //
  // The list is also a snapshot taken before anything is unclaimed, so the walk
  // never reads a structure that `unclaim` is in the middle of changing.

  /** Every chunk in the mine that is claimed by anyone other than the server. */
  const mineClaimedChunks = server => {
    const dim = MineResourceLocation.parse(MINE_DIM)
    const infos = MinePAC.get(server).getServerClaimsManager().getPlayerInfoStream().toList()
    const found = []
    for (let i = 0; i < infos.size(); i++) {
      var info = infos.get(i)
      if (info.getPlayerId().equals(MinePlayerConfig.SERVER_CLAIM_UUID)) continue
      var dimClaims = info.getDimension(dim)
      if (dimClaims == null) continue
      // One list per claim state — a player with two sub-configs in the mine
      // has two, and both have to be walked.
      var lists = dimClaims.getStream().toList()
      for (let j = 0; j < lists.size(); j++) {
        var chunks = lists.get(j).getStream().toList()
        for (let k = 0; k < chunks.size(); k++) {
          found.push(chunks.get(k))
        }
      }
    }
    return found
  }

  const mineUnclaim = context => {
    const source = context.getSource()
    const server = source.getServer()
    const dim = MineResourceLocation.parse(MINE_DIM)
    const manager = MinePAC.get(server).getServerClaimsManager()

    const chunks = mineClaimedChunks(server)
    for (let i = 0; i < chunks.length; i++) {
      manager.unclaim(dim, chunks[i].x, chunks[i].z)
    }

    console.info('[ravenforge] mine reset: unclaimed ' + chunks.length
      + ' chunk(s) in ' + MINE_DIM + ', server claim left in place')
    source.sendSystemMessage(Text.of('Zdjęto działki w kopalni: '
      + chunks.length + ' chunk(ów). Claim serwerowy został.'))
    return chunks.length
  }

  const mineEvacuate = context => {
    const source = context.getSource()
    const server = source.getServer()
    const spawn = server.overworld().getSharedSpawnPos()

    // Built as a command instead of `teleportTo`, because the cross-dimension
    // overload takes six arguments and Rhino cannot pick between the double and
    // the float form — measured in `rtp.js`, where only the three-argument form
    // resolved. `execute in <dim> run tp` does the dimension change for us.
    const destination = ' ' + spawn.getX() + ' ' + spawn.getY() + ' ' + spawn.getZ()
    // Suppressed, or every online op reads "[Rcon: Teleported <name> to ..."
    // once per evacuated player. Measured — the player's own notice below is
    // the message that should land.
    const quiet = source.withSuppressedOutput()
    const players = server.getPlayerList().getPlayers()
    let moved = 0
    for (let i = 0; i < players.size(); i++) {
      var player = players.get(i)
      // `dimension` is a PROPERTY here, not a method, and it already prints as
      // the plain id — `dimension()` throws "not a function, it is object" and
      // `.location()` does not exist on what it returns. Measured on the rig.
      if (String(player.serverLevel().dimension) !== MINE_DIM) continue
      server.getCommands().performPrefixedCommand(quiet,
        'execute in minecraft:overworld run tp ' + player.getGameProfile().getName() + destination)
      player.sendSystemMessage(Text.yellow('Kopalnia jest resetowana. Wracasz na spawn.'))
      moved++
    }

    console.info('[ravenforge] mine reset: moved ' + moved + ' player(s) out of ' + MINE_DIM)
    source.sendSystemMessage(Text.of('Wyprowadzono z kopalni: ' + moved + ' gracz(y).'))
    return moved
  }

  // Level 4 only: the console AMP schedules this from, and nobody else. This is
  // deliberately not a LuckPerms node — the caller that matters is the console,
  // which is not a LuckPerms user at all.
  //
  // Both bodies live in functions of their own so `executes` can wrap them:
  // Brigadier swallows exceptions out of a command, the player sees "An
  // unexpected error occurred" and the log sees nothing. Same shape as `rtp.js`.
  ServerEvents.commandRegistry(event => {
    event.register(event.commands.literal('mine')
      .requires(source => source.hasPermission(4))
      .then(event.commands.literal('evacuate').executes(context => {
        try {
          return mineEvacuate(context)
        } catch (error) {
          console.error('[ravenforge] mine evacuate failed: ' + error)
          context.getSource().sendFailure(Text.red('Wyprowadzenie z kopalni zawiodło.'))
          return 0
        }
      }))
      .then(event.commands.literal('unclaim').executes(context => {
        try {
          return mineUnclaim(context)
        } catch (error) {
          console.error('[ravenforge] mine unclaim failed: ' + error)
          context.getSource().sendFailure(Text.red('Zdjęcie działek w kopalni zawiodło.'))
          return 0
        }
      })))
  })
})()
