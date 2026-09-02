// White Ravens Forge — the End dragon.
//
// Two jobs, both server side:
//   /dragon respawn   puts the four end crystals back on the exit portal and
//                     asks the vanilla fight to start the respawn. Meant for a
//                     weekly scheduler task, so it is idempotent: crystals that
//                     are already in place are left alone.
//   dragon egg        vanilla drops the egg only on the FIRST kill
//                     (EndDragonFight.setDragonKilled checks previouslyKilled).
//                     The egg is a crafting ingredient here, so every kill gets
//                     one. We place it ourselves on every kill after the first.
//
// Everything lives in one function: KubeJS shares a single scope across scripts.
(function () {
  const DrBlockPos = Java.loadClass('net.minecraft.core.BlockPos')
  const DrAABB = Java.loadClass('net.minecraft.world.phys.AABB')
  const DrCrystal = Java.loadClass('net.minecraft.world.entity.boss.enderdragon.EndCrystal')
  const DrBlocks = Java.loadClass('net.minecraft.world.level.block.Blocks')

  const DR_DIM = 'minecraft:the_end'
  // The four horizontal directions, spelled out. BlockPos.relative(Direction,int)
  // is ambiguous for Rhino and Direction.getStepX() is not reachable from it.
  const DR_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const DR_SEAT = 3   // crystals sit on the bedrock rim, three out
  const DR_LOOK = 2   // ...which is where EndDragonFight.tryRespawn looks for them
  const DR_EVERY = 20
  const DR_GIVE_UP = 300  // polls, i.e. 100 minutes of waiting for the portal

  var drWaiting = 0

  const drEnd = server => {
    var found = null
    var seen = null
    const levels = server.getAllLevels().iterator()
    while (levels.hasNext()) {
      seen = levels.next()
      if (String(seen.dimension) === DR_DIM) found = seen
    }
    return found
  }

  const drId = (level, pos) => String(level.getBlockState(pos).getBlock().getDescriptionId())

  // Base of the exit portal: EndPodiumFeature.place() is called with it, so the
  // bedrock pillar is base .. base+3 and the portal blocks sit at base.
  const drPortal = level => {
    var stored = level.dragonFight.saveData().exitPortalLocation()
    if (stored.isPresent()) return stored.get()
    // No saved location yet — find the pillar. Bedrock is unbreakable, so the
    // topmost bedrock in the middle column is a reliable landmark.
    for (let y = 120; y > 0; y--) {
      var here = new DrBlockPos(0, y, 0)
      if (drId(level, here) === 'block.minecraft.bedrock') return new DrBlockPos(0, y - 3, 0)
    }
    return null
  }

  const drSide = (portal, side, out) =>
    new DrBlockPos(portal.getX() + side[0] * out, portal.getY() + 1, portal.getZ() + side[1] * out)

  const drRespawn = source => {
    const server = source.getServer()
    const say = text => { source.sendSystemMessage(Text.of(text)); console.info('dragon: ' + text) }

    const level = drEnd(server)
    if (level == null) { say('Nie ma wymiaru ' + DR_DIM + '.'); return }

    const fight = level.dragonFight
    if (fight == null) { say('Ten wymiar nie ma walki ze smokiem.'); return }

    if (level.getDragons().size() > 0) { say('Smok już żyje — nic nie robię.'); return }

    if (!fight.saveData().dragonKilled()) {
      say('Walka nie jest w stanie „smok zabity" — pierwszego smoka musi zabić gracz.')
      return
    }

    const portal = drPortal(level)
    if (portal == null) { say('Nie znalazłem portalu wyjściowego.'); return }

    var placed = 0
    var stood = 0
    for (let i = 0; i < DR_SIDES.length; i++) {
      var look = drSide(portal, DR_SIDES[i], DR_LOOK)
      if (!level.getEntitiesOfClass(DrCrystal, new DrAABB(look)).isEmpty()) { stood = stood + 1; continue }
      var seat = drSide(portal, DR_SIDES[i], DR_SEAT)
      var crystal = new DrCrystal(level, seat.getX() + 0.5, seat.getY(), seat.getZ() + 0.5)
      crystal.setShowBottom(false)
      level.addFreshEntity(crystal)
      placed = placed + 1
    }

    fight.tryRespawn()
    say('Portal ' + portal + ': kryształy ' + placed + ' nowych, ' + stood + ' już stało. ' +
        'Respawn ruszy, gdy ktoś będzie na wyspie — walka tyka tylko przy graczu w promieniu 192.')
  }

  // The dragon dies at dragonDeathTime 200, and only then does vanilla rebuild
  // the exit portal. Placing the egg on a timer would race that rebuild, which
  // wipes everything above the pillar — so we wait for the portal blocks to come
  // back instead. That is the same trick the mine platform uses.
  const drEggDue = server => {
    const level = drEnd(server)
    if (level == null) return true
    const portal = drPortal(level)
    if (portal == null) return false
    var gate = new DrBlockPos(portal.getX() + DR_LOOK, portal.getY(), portal.getZ())
    if (drId(level, gate) !== 'block.minecraft.end_portal') return false

    var pos = new DrBlockPos(portal.getX(), portal.getY() + 4, portal.getZ())
    while (!level.getBlockState(pos).isAir() && pos.getY() < portal.getY() + 20) pos = pos.above(1)
    level.setBlockAndUpdate(pos, DrBlocks.DRAGON_EGG.defaultBlockState())
    console.info('dragon: jajo postawione na ' + pos)
    return true
  }

  EntityEvents.death('minecraft:ender_dragon', event => {
    try {
      // var, not const: Rhino shares one scope across scripts and a const
      // inside a try block collides at run time, not at load time.
      var arena = drEnd(event.server)
      if (arena == null || arena.dragonFight == null) return
      // The first kill is vanilla's — previouslyKilled is still false here,
      // it is set in the same call that places vanilla's own egg.
      if (!arena.dragonFight.hasPreviouslyKilledDragon()) return
      drWaiting = DR_GIVE_UP
      console.info('dragon: kolejne zabicie — czekam na portal, żeby postawić jajo')
    } catch (error) {
      console.error('dragon: śmierć smoka: ' + error)
    }
  })

  var drTicks = 0
  ServerEvents.tick(event => {
    if (drWaiting <= 0) return
    drTicks = drTicks + 1
    if (drTicks % DR_EVERY !== 0) return
    try {
      drWaiting = drWaiting - 1
      if (drEggDue(event.server)) { drWaiting = 0; return }
      if (drWaiting <= 0) console.warn('dragon: portal nie wrócił — jaja nie postawiłem')
    } catch (error) {
      drWaiting = 0
      console.error('dragon: stawianie jaja: ' + error)
    }
  })

  ServerEvents.commandRegistry(event => {
    const Cmd = event.commands
    event.register(Cmd.literal('dragon')
      .requires(source => source.hasPermission(4))
      .then(Cmd.literal('respawn').executes(ctx => {
        try { drRespawn(ctx.source) } catch (error) { console.error('dragon respawn: ' + error) }
        return 1
      })))
  })
})()
