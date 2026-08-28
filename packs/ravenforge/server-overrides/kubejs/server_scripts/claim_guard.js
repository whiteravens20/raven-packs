// White Ravens Forge — the claim guard.
//
// Open Parties and Claims stops anything that goes through a block event or
// carries an entity. It is blind to a machine that writes straight into the
// level with `setBlock`, and CoreProtect is blind to the same call, so there
// is not even a log entry to roll back. Four machines in this pack take that
// route; without this guard a Plant Gatherer parked one block outside a
// neighbour's claim harvests their field and leaves no trace.
//
// OPAC's own API answers the question the machines avoid asking:
//
//   OpenPACServerAPI.get(server).getChunkProtection()
//     .hasChunkAccess(playerUuid, dimension, chunkX, chunkZ)
//
// It honours parties, sub-configs and every OPAC exception, and it returns
// true for an unclaimed chunk — so the guard costs nothing in open country
// and bites only where a placement would reach into someone else's claim.
// The check runs once, when the block is placed. Nothing runs per tick.
const PAC = Java.loadClass('xaero.pac.common.server.api.OpenPACServerAPI')

// Working radius in blocks. Industrial Foregoing's area machines take twelve
// range addons and compute the radius as `range + 1`, so 13 is the ceiling.
// EnderIO's numbers are `getMaxRange()` in the block entity: the drain 10,
// the farming station 5. Every one of these was read from the jar.
//
// Only machines that do NOT ask OPAC for permission belong here. The Block
// Breaker, the Block Placer, the fluid tiles and the Wither Builder all run
// `BlockUtils.canBlockBeBroken`, which posts a BreakEvent that OPAC cancels
// on its own — adding them would be duplicate work with a worse message.
const AREA_MACHINES = {
  'industrialforegoing:plant_gatherer': 13,
  'industrialforegoing:plant_sower': 13,
  'enderio:drain': 10,
  'enderio:farming_station': 5,
}

// The same API, second use. Inside a claim OPAC already refuses fire from a
// stranger, stops fluid at the boundary and blocks explosion damage; open
// country is the part that is exposed. So a fire source works in a claim you
// may build in — and in the mining dimension, where everything is temporary.
//
// Nothing from Immersive Petroleum is listed: of its ten fluids only napalm
// spreads fire when placed (`NapalmFluidBlock` posts to `Blocks.FIRE`), and
// napalm's single recipe is already gone with the firearms.
const FIRE_SOURCES = [
  'minecraft:flint_and_steel',
  'minecraft:fire_charge',
  'minecraft:lava_bucket',
]

// Not built yet — see the mining dimension section of the pack plan. This is
// the one line to change if the dimension is ever renamed.
const MINING = 'ravenforge:mining'

/** True when every chunk the machine can reach is one this player may use. */
const areaIsClear = (server, uuid, dim, x, z, radius) => {
  const protection = PAC.get(server).getChunkProtection()
  for (let cx = (x - radius) >> 4; cx <= (x + radius) >> 4; cx++) {
    for (let cz = (z - radius) >> 4; cz <= (z + radius) >> 4; cz++) {
      if (!protection.hasChunkAccess(uuid, dim, cx, cz)) return false
    }
  }
  return true
}

/** True when this chunk is claimed AND this player may act in it. */
const isOwnClaim = (server, uuid, dim, x, z) => {
  const api = PAC.get(server)
  const cx = x >> 4
  const cz = z >> 4
  if (api.getServerClaimsManager().get(dim, cx, cz) == null) return false
  return api.getChunkProtection().hasChunkAccess(uuid, dim, cx, cz)
}

BlockEvents.placed(event => {
  const radius = AREA_MACHINES[String(event.block.id)]
  if (radius === undefined) return

  const player = event.player
  if (player == null) {
    // Placed by a machine, so there is no one to check the claims against.
    // Refusing is the only answer that cannot open a hole.
    console.warn('[ravenforge] area machine placed with no player at '
      + event.block.pos + ' — refused')
    event.cancel()
    return
  }

  const block = event.block
  if (areaIsClear(event.server, player.uuid, block.dimension, block.x, block.z, radius)) return

  event.cancel()
  player.tell(Text.red('Ta maszyna sięga ' + radius
    + ' kratek i dostałaby się na cudzą działkę. Postaw ją dalej od granicy.'))
})

// Known side effect: cancelling a right click cancels the whole interaction,
// so in open country a player holding a fire source cannot open a chest until
// they swap item. NeoForge can deny just the item half of the interaction
// (`RightClickBlock.setUseItem(DENY)`), but KubeJS only exposes a full cancel.
// Inside a claim nothing changes, which is where people keep their chests.
BlockEvents.rightClicked(event => {
  if (FIRE_SOURCES.indexOf(String(event.item.id)) < 0) return

  // Flint and steel and a bucket act on the face, not on the block clicked,
  // and the two sit in different chunks on a boundary.
  const target = event.block.offset(event.facing)
  if (String(target.dimension) === MINING) return

  const player = event.player
  if (player != null && isOwnClaim(event.server, player.uuid, target.dimension, target.x, target.z)) return

  event.cancel()
  if (player != null) {
    player.tell(Text.red('Ogień i lawa tylko na własnej działce albo w kopalni.'))
  }
})
