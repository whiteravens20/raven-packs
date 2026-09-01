// White Ravens Forge — random teleport.
//
// ravenclassic gives a new player /rtp so they can find somewhere to put a
// first claim without walking out of spawn for twenty minutes. Henny Essentials
// has no random-teleport command at all, so this is the one player command from
// that ladder the pack has to supply itself.
//
// Written rather than installed for a reason worth stating. Two RTP mods build
// for NeoForge 1.21.1 — leafrtp and extrartp — and neither carries a single
// reference to Xaero or Open Parties and Claims, measured in both jars. A
// claim-blind random teleport drops strangers inside other people's bases,
// which on a server built around claims is the one thing it must not do. The
// OPAC call that prevents it is already proven in claim_guard.js.
//
// THE LANDING IS THE WHOLE PROBLEM. A random point is trivial; a point a player
// survives is not. Everything below exists because of one specific way to die:
//
//   suffocation      two blocks of air above the floor, always
//   drowning         the floor must have an empty FluidState, and the pocket
//                    must be air — water is neither
//   lava underfoot   same two checks, plus the id blacklist
//   lava nearby      a 5x5x4 scan around the landing, because the floor of a
//                    lava lake's edge is solid netherrack and passes every
//                    other test
//   a cave           in a dimension with sky, only the heightmap top is ever
//                    considered, so the spot is the surface by construction
//   the void         rejected against the world floor and ceiling
//   cactus, magma, campfire, powder snow, dripstone, fire — the blacklist,
//                    matched on descriptionId, which is a plain string on the
//                    state and needs no registry lookup
//
// THE NETHER IS A DIFFERENT ALGORITHM. It has a bedrock ceiling, so there is no
// heightmap "surface" to stand on — MOTION_BLOCKING returns the roof. There the
// search scans downward from below the ceiling for the first pocket that passes
// the same tests, and refuses to go below the lava sea. dimensionType().
// hasCeiling() is what picks between the two, so a dimension added later gets
// the right treatment without this file knowing its name.
//
// The mining dimension needs no special case: its dimension_type declares
// has_skylight true and has_ceiling false, so it takes the overworld path.
//
// Cost: probing terrain forces the chunk in, and generating a fresh chunk on
// the server thread is a visible hitch. The pack ships Chunky for exactly this
// — pregenerate to the radius and the probes read from disk instead of
// generating. Until that is done, expect the first calls into untouched terrain
// to stutter. The radii below assume the world is set up as docs/world.txt
// describes: spawn near the border centre, and the border at least a thousand
// blocks wider than the largest radius here.
// Wrapped in a function because KubeJS runs every server script in one shared
// scope: two files declaring the same `const` is a redeclaration error, and it
// takes the second file down entirely rather than just the name. Measured —
// `MINING` was declared here and in the gate, and the gate stopped loading.
//
// Nothing below declares a variable inside a `try` block. That combination
// collides in the shared scope and fails at RUN time, not load time, with
// "redeclaration of var <name>" — four separate times while writing the rank
// guard, every one of them a const inside a try.
(function () {
  const RtpProvider = Java.loadClass('net.luckperms.api.LuckPermsProvider')
  const RtpPac = Java.loadClass('xaero.pac.common.server.api.OpenPACServerAPI')
  const RtpHeightmap = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')
  const RtpBlockPos = Java.loadClass('net.minecraft.core.BlockPos')

  const RTP_NODE = 'ravenforge.rtp'
  const RTP_ATTEMPTS = 24
  const RTP_COOLDOWN_MS = 300000

  // The wait is not decoration. Measured on the rig: 24 probes into terrain
  // that had never been generated cost 25 seconds of server thread — about a
  // second per chunk generated. A player who asked by accident, or who is
  // being chased, gets eight seconds to walk away and spend none of it.
  const RTP_WARMUP_TICKS = 160
  const RTP_MOVE_TOLERANCE = 0.4

  // Per dimension, because a nether block is eight overworld blocks wide and a
  // 4000-block radius there would cover most of the map. Centred on world
  // spawn, not on the caller: this is "put me somewhere to settle", not free
  // long-distance travel from wherever you happen to stand.
  // `ceiling` says which of the two searches a dimension needs. It is written
  // here rather than read from dimensionType() on purpose: this table already
  // has to name every dimension the command works in, so one row carries the
  // whole answer and the script needs no dimension API at all. The mining
  // dimension takes the open-sky path because its dimension_type declares
  // has_skylight true and has_ceiling false — checked in the datapack.
  // `originScale` turns world spawn into this dimension's coordinates.
  // getSharedSpawnPos() answers with the OVERWORLD spawn in every dimension —
  // a non-overworld level wraps the same ServerLevelData in DerivedLevelData,
  // so there is no per-dimension spawn to read. Left unscaled that is a live
  // fault rather than a rounding error: with the border at ±5000 and spawn
  // moved to 3000,3000 the nether ring would centre on nether 3000,3000, which
  // is overworld 24000 and outside the border — every candidate would be
  // rejected and /rtp would fail there permanently. 1/8 is the nether's
  // coordinate_scale read backwards: overworld coordinates divided by eight.
  const RTP_WORLDS = {
    'minecraft:overworld': { radius: 4000, min: 500, originScale: 1, ceiling: false },
    'ravenforge:mining': { radius: 3000, min: 200, originScale: 1, ceiling: false },
    'minecraft:the_nether': {
      radius: 800, min: 100, originScale: 0.125,
      ceiling: true, top: 120, bottom: 32,
    },
  }

  // The End is absent on purpose, not by oversight. It is one island over a
  // void with the dragon on it, reached deliberately; dropping somebody at a
  // random point there means the void or the outer islands, and neither is a
  // place to arrive by accident. A dimension missing from the table above is
  // refused, so anything added later has to be considered before it works.

  const RTP_UNSAFE = ['magma_block', 'cactus', 'sweet_berry', 'powder_snow', 'campfire',
    'wither_rose', 'pointed_dripstone', 'lava', 'fire', 'nether_portal', 'end_portal']

  // How far a lava lake may be from the landing. Two blocks of margin is enough
  // that a player who moves before they get their bearings does not walk in.
  const RTP_CLEAR = 2

  const rtpLastUse = {}
  const rtpPending = {}

  // A permission check must never take the command down with it. If LuckPerms
  // cannot answer for this player, the answer is no, said plainly, with the
  // reason in the log rather than a Brigadier stack trace the player cannot read.
  // Resolved by uuid through the UserManager, which is the route Henny
  // Essentials itself takes. Two reasons, both learned the hard way on the rig:
  // getPlayerAdapter computes from session contexts and answers false for a
  // player it has no session for, and UserManager.getUser is overloaded on
  // UUID and String, which Rhino cannot tell apart when handed a JavaScript
  // string — the uuid form is unambiguous. The uuid itself comes off the
  // GameProfile rather than Entity.getUUID(), which KubeJS's Rhino does not
  // expose at all ("Cannot find function getUUID", measured); GameProfile is
  // plain authlib and is not remapped.
  const rtpMayUse = player => {
    let user = null
    try {
      user = RtpProvider.get().getUserManager().getUser(player.getGameProfile().getId())
    } catch (error) {
      console.error('[ravenforge] rtp: LuckPerms could not answer for '
        + player.getGameProfile().getName() + ' — ' + error)
      return false
    }
    if (user == null) return false
    return user.getCachedData().getPermissionData().checkPermission(RTP_NODE).asBoolean()
  }

  const rtpIsUnsafe = state => {
    const id = String(state.getBlock().getDescriptionId())
    for (let i = 0; i < RTP_UNSAFE.length; i++) {
      if (id.indexOf(RTP_UNSAFE[i]) >= 0) return true
    }
    return false
  }

  /** True when the player can stand at this y with a floor under them. */
  const rtpPocketOk = (level, x, y, z) => {
    const floor = level.getBlockState(new RtpBlockPos(x, y - 1, z))
    if (!floor.blocksMotion()) return false
    if (!floor.getFluidState().isEmpty()) return false
    if (rtpIsUnsafe(floor)) return false
    if (!level.getBlockState(new RtpBlockPos(x, y, z)).isAir()) return false
    if (!level.getBlockState(new RtpBlockPos(x, y + 1, z)).isAir()) return false
    return true
  }

  /**
   * True when anything in RTP_CLEAR blocks of the landing would hurt. The
   * horizontal sweep is what catches the shore of a lava lake, whose floor is
   * ordinary solid ground and passes every test in rtpPocketOk.
   */
  const rtpDangerNear = (level, x, y, z) => {
    for (let dx = -RTP_CLEAR; dx <= RTP_CLEAR; dx++) {
      for (let dz = -RTP_CLEAR; dz <= RTP_CLEAR; dz++) {
        for (let dy = -1; dy <= 2; dy++) {
          if (rtpIsUnsafe(level.getBlockState(new RtpBlockPos(x + dx, y + dy, z + dz)))) return true
        }
      }
    }
    return false
  }

  /** A y to stand on, or null when this column is no good. */
  const rtpFindY = (level, world, x, z) => {
    // The chunk has to be in before the heightmap or any block read means
    // anything: an absent chunk answers with defaults, not with the world.
    level.getChunk(x >> 4, z >> 4)
    const floor = level.getMinBuildHeight()
    const roof = level.getMaxBuildHeight()

    if (!world.ceiling) {
      const surface = level.getHeight(RtpHeightmap.MOTION_BLOCKING_NO_LEAVES, x, z)
      if (surface <= floor + 1 || surface >= roof - 2) return null
      if (!rtpPocketOk(level, x, surface, z)) return null
      if (rtpDangerNear(level, x, surface, z)) return null
      return surface
    }

    // Ceilinged, so there is no surface. Walk down from under the roof and take
    // the first pocket that holds up. The lower bound keeps the search out of
    // the lava sea rather than trusting the blacklist to catch every column.
    for (let y = world.top; y > world.bottom; y--) {
      if (!rtpPocketOk(level, x, y, z)) continue
      if (rtpDangerNear(level, x, y, z)) continue
      return y
    }
    return null
  }

  // The body lives in a function of its own so `executes` can wrap it. An
  // exception escaping a Brigadier command reaches the player as "An unexpected
  // error occurred" and reaches the log as nothing at all, which is how three
  // separate faults in this file stayed invisible on the rig.
  const rtpBegin = context => {
      const source = context.getSource()
      const player = source.getPlayer()
      if (player == null) {
        source.sendFailure(Text.red('Ta komenda jest dla graczy.'))
        return 0
      }
      if (!rtpMayUse(player)) {
        source.sendFailure(Text.red('Nie masz uprawnienia do losowej teleportacji.'))
        return 0
      }

      const level = source.getLevel()
      const world = RTP_WORLDS[String(level.dimension)]
      if (world === undefined) {
        source.sendFailure(Text.red('Losowa teleportacja nie działa w tym wymiarze.'))
        return 0
      }

      const uuid = String(player.getGameProfile().getId())
      const waited = Date.now() - (rtpLastUse[uuid] || 0)
      if (waited < RTP_COOLDOWN_MS) {
        source.sendFailure(Text.red('Poczekaj jeszcze '
          + Math.ceil((RTP_COOLDOWN_MS - waited) / 1000) + ' s.'))
        return 0
      }

      rtpPending[uuid] = {
        player: player,
        level: level,
        world: world,
        ticks: RTP_WARMUP_TICKS,
        x: player.position().x,
        y: player.position().y,
        z: player.position().z,
      }
      player.sendSystemMessage(Text.green('Losowa teleportacja za '
        + (RTP_WARMUP_TICKS / 20) + ' s. Nie ruszaj się.'))
      return 1
  }

  ServerEvents.commandRegistry(event => {
    event.register(event.commands.literal('rtp').executes(context => {
      try {
        return rtpBegin(context)
      } catch (error) {
        console.error('[ravenforge] rtp failed: ' + error)
        context.getSource().sendFailure(Text.red('Losowa teleportacja zawiodła. Zgłoś to administracji.'))
        return 0
      }
    }))
  })

  /** The search itself, run once the wait is over. */
  const rtpJump = waiting => {
    const player = waiting.player
    const level = waiting.level
    const uuid = String(player.getGameProfile().getId())
    const spawn = level.getSharedSpawnPos()
    const border = level.getWorldBorder()
    const protection = RtpPac.get(level.getServer()).getChunkProtection()
    const originX = spawn.getX() * waiting.world.originScale
    const originZ = spawn.getZ() * waiting.world.originScale
    // Squared, because the distance is drawn uniformly over AREA and not over
    // radius. `min + random * (max - min)` puts the same number of landings in
    // every ring of equal width, and the ring at 500 blocks is eight times
    // smaller in area than the ring at 4000 — so per square metre a player
    // lands eight times more often next to spawn. On a server built on claims
    // that is everybody fighting over the same near ground while the outer ring
    // stays empty, and it wastes most of the pregenerated disc. Taking the
    // square root of a uniform pick between the two squared radii spreads the
    // landings evenly across the disc instead.
    const nearSq = waiting.world.min * waiting.world.min
    const farSq = waiting.world.radius * waiting.world.radius
    let x = 0
    let z = 0
    let angle = 0
    let distance = 0
    let y = null
    let outside = 0

    for (let attempt = 0; attempt < RTP_ATTEMPTS; attempt++) {
      angle = Math.random() * Math.PI * 2
      distance = Math.sqrt(nearSq + Math.random() * (farSq - nearSq))
      x = Math.round(originX + Math.cos(angle) * distance)
      z = Math.round(originZ + Math.sin(angle) * distance)

      if (!border.isWithinBounds(x, z)) {
        outside++
        continue
      }
      // Somebody else's ground. hasChunkAccess answers true for an unclaimed
      // chunk, so this costs nothing in open country and only bites where the
      // landing would be inside a claim this player may not use.
      if (!protection.hasChunkAccess(player.getGameProfile().getId(), level.dimension, x >> 4, z >> 4)) continue

      y = rtpFindY(level, waiting.world, x, z)
      if (y == null) continue

      rtpLastUse[uuid] = Date.now()
      // The three-argument form, deliberately. ServerPlayer overrides it to go
      // through connection.teleport with RelativeMovement.ROTATION, so the
      // client is told and the player keeps the way they were facing. The six
      // argument form is ambiguous to Rhino — "The choice of Java method
      // teleportTo ... is ambiguous", measured — and taking a rotation would
      // have meant getYRot, which KubeJS does not expose either. Same dimension
      // throughout, which is all this form supports and all this command does.
      player.teleportTo(x + 0.5, y, z + 0.5)
      player.sendSystemMessage(Text.green('Przeniesiono: ' + x + ', ' + y + ', ' + z))
      return
    }
    // Two failures that look the same to the player and are not. Terrain the
    // search would not accept is ordinary and clears on a retry. A ring lying
    // entirely outside the border never clears, and "try again" would send the
    // player round that loop forever — it is a server misconfiguration, either
    // spawn moved far from the border centre or a border smaller than the
    // radius in the table above. So it says something different and leaves the
    // numbers in the log for whoever has to fix it.
    if (outside === RTP_ATTEMPTS) {
      console.warn('[ravenforge] rtp: every candidate in ' + String(level.dimension)
        + ' fell outside the world border. Ring is ' + waiting.world.min + '-'
        + waiting.world.radius + ' blocks around ' + Math.round(originX) + ', '
        + Math.round(originZ) + '; widen the border or move spawn back to its centre.')
      player.sendSystemMessage(Text.red('Losowa teleportacja jest źle ustawiona na tym serwerze. Zgłoś to administracji.'))
      return
    }
    player.sendSystemMessage(Text.red('Nie znaleziono bezpiecznego miejsca. Spróbuj ponownie.'))
  }

  const rtpTick = () => {
    const uuids = Object.keys(rtpPending)
    if (uuids.length === 0) return
    let waiting = null
    let moved = 0
    let uuid = null
    let here = null
    for (let i = 0; i < uuids.length; i++) {
      uuid = uuids[i]
      waiting = rtpPending[uuid]

      // Movement cancels, which is the whole point of the wait: it has to cost
      // something to stand still. Compared against the position the command was
      // typed at, so a step in any direction counts, not only a net one.
      here = waiting.player.position()
      moved = Math.abs(here.x - waiting.x) + Math.abs(here.y - waiting.y) + Math.abs(here.z - waiting.z)
      if (moved > RTP_MOVE_TOLERANCE) {
        delete rtpPending[uuid]
        waiting.player.sendSystemMessage(Text.red('Ruszyłeś się — teleportacja anulowana.'))
        continue
      }

      waiting.ticks--
      if (waiting.ticks % 20 === 0 && waiting.ticks > 0) {
        waiting.player.displayClientMessage(Text.green('Teleportacja za ' + (waiting.ticks / 20) + ' s...'), true)
      }
      if (waiting.ticks <= 0) {
        delete rtpPending[uuid]
        rtpJump(waiting)
      }
    }
  }

  // A throw here would repeat sixty times a second, so a failure clears the
  // queue rather than filling the log with the same line.
  ServerEvents.tick(event => {
    try {
      rtpTick()
    } catch (error) {
      console.error('[ravenforge] rtp tick failed, queue cleared: ' + error)
      const stuck = Object.keys(rtpPending)
      for (let i = 0; i < stuck.length; i++) delete rtpPending[stuck[i]]
    }
  })
})()
