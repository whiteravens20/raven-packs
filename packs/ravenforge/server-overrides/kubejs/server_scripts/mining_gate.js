// White Ravens Forge — the mining dimension gate.
//
// These items may be crafted freely and carried anywhere; they only work in
// the mining dimension. A quarry that eats a chunk and a stick of TNT are the
// same problem stated twice: both rewrite terrain faster than anyone can put
// it back, and the mine is the one place where that is fine, because it is
// wiped every thirty days.
//
// Three layers, because each catches a different route into the world:
// a block being placed (the player), an entity appearing (dispensers and
// redstone, which never place a block), and an item being used on a block
// (a minecart and the bore, which spawn an entity instead).// Wrapped in a function because KubeJS runs every server script in one shared
// scope: two files declaring the same `const` is a redeclaration error, and it
// takes the second file down entirely rather than just the name. Measured —
// `MINING` was declared here and in the gate, and the gate stopped loading.
(function () {
  const MINING = 'ravenforge:mining'

  // QuarryPlus's other quarries — mini_quarry, mining_well, solid_fuel_quarry,
  // filler — are absent on purpose: they have no recipe in 21.1.162, so they
  // cannot enter a survival world at all.
  //
  // The Chunk Destroyer (`adv_quarry`) is gated rather than banned. It reaches
  // no further than the quarry does — both read the same markers, and both are
  // capped by `markerPlusRange` / `flexibleMarkerRange`, which the pack sets to
  // 64. Without markers it takes the single chunk it stands in. What it adds is
  // speed, and speed is only a problem where the terrain is kept, so the mine
  // is exactly where it belongs. Its recipe wants a dragon head and a nether
  // star, so it arrives late on its own.
  const GATED_BLOCKS = [
    'quarryplus:quarry',
    'quarryplus:adv_quarry',
    'quarryplus:adv_pump',
    'minecraft:tnt',
    'ae2:tiny_tnt',
  ]

  // A dispenser can throw TNT into the world as an entity that is already lit,
  // with no block ever placed. There is no item to hand back on this path, so
  // cancelling the entity is both the only option and a harmless one.
  const GATED_ENTITIES = [
    'minecraft:tnt',
    'ae2:tiny_tnt_primed',
  ]

  // Used on a block, spawn an entity, and are consumed in the process — so the
  // interaction has to be stopped before the item is spent, not after.
  const GATED_ITEMS = [
    'minecraft:tnt_minecart',
    'railcraft:tunnel_bore',
  ]

  const DENIED = 'Tylko w wymiarze kopalnianym.'

  // Told and logged. A gate that only whispers to the player leaves an operator
  // with nothing to look at when someone spends an evening probing it, and the
  // dispenser path has no player to whisper to at all.
  //
  // Tell before `cancel()`, always: `cancel()` unwinds the handler, so a line
  // written after it never runs. Measured — the refusal worked and the player
  // was never told why.
  const refuse = (player, what, where, dim) => {
    console.info('[ravenforge] mining gate: ' + what + ' refused for ' +
      (player == null ? '<no player>' : player.username) + ' at ' + where + ' in ' + dim)
    if (player != null) player.tell(Text.red(DENIED))
  }

  // `event.cancel()`, never `set('air')` plus `give`: the rebuild-and-refund
  // variant duplicates the machine. `BlockItem.place` ends in an unconditional
  // `consume(1)` on the stack it captured before the event, and KubeJS's `give`
  // swaps the stack object, so the consume takes the item off an orphan. One
  // quarry in hand became two on the ground, three times out of three.
  BlockEvents.placed(event => {
    if (GATED_BLOCKS.indexOf(String(event.block.id)) < 0) return
    if (String(event.level.dimension) === MINING) return
    refuse(event.player, event.block.id, event.block.pos, event.level.dimension)
    event.cancel()
  })

  GATED_ENTITIES.forEach(type => {
    EntityEvents.spawned(type, event => {
      if (String(event.level.dimension) === MINING) return
      refuse(null, type, event.entity.blockPosition(), event.level.dimension)
      event.cancel()
    })
  })

  BlockEvents.rightClicked(event => {
    if (GATED_ITEMS.indexOf(String(event.item.id)) < 0) return
    if (String(event.level.dimension) === MINING) return
    refuse(event.player, event.item.id, event.block.pos, event.level.dimension)
    event.cancel()
  })
})()
