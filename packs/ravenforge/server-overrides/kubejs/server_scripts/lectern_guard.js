// White Ravens Forge — the lectern guard.
//
// A lectern on a server claim is a noticeboard: the rules, the price list, the
// season's announcement. It is only a noticeboard if everybody can read it and
// nobody can walk off with it, and Open Parties and Claims cannot express that
// split on its own.
//
// WHY OPAC CANNOT. Measured in the 0.30.3 jar: it subscribes to
// PlayerInteractEvent, BlockEvent and the entity events, and to NO container or
// menu event at all — the only menu class it touches is a Radial Wrench packet
// mixin. So its `Lecterns` exception group decides one thing, whether the
// lectern OPENS. Everything after that happens inside LecternMenu, where OPAC
// has no listener: the "Take Book" button is `clickMenuButton` case 3, and its
// only gate is `player.mayBuild()`, which is false in adventure mode and true
// for everybody else. Open the lectern for reading and you have opened it for
// taking, in the same line of config.
//
// So the reading is opened in config/openpartiesandclaims-server.toml, and the
// taking is closed here.
//
// HOW IT CLOSES. When the menu opens, the book on the lectern is copied. When
// it closes with the lectern empty, the book left with the player — nothing
// else can empty a lectern from inside its own menu — and it goes straight
// back. `LecternBlock.tryPlaceBook` is vanilla's own placement path: it calls
// `stack.consumeAndReturn(1, player)`, so handing it the player's stack takes
// the book out of the inventory and puts it on the lectern in one call, and it
// fixes HAS_BOOK, the redstone signal and the sound the same way a player
// placing a book would. Nothing is duplicated and nothing is spawned.
//
// ⚠ ONLY ON SERVER CLAIMS. A player's own lectern on their own claim stays
// vanilla — taking your book back out of your own noticeboard is not theft.
// The claim is read from OPAC and compared against PlayerConfig.SERVER_CLAIM_UUID,
// the same constant mine_reset.js uses to skip server claims.
//
// ⚠ A CREATIVE PLAYER STILL KEEPS A COPY. `consumeAndReturn` does not shrink
// for an entity with infinite materials, so an operator in creative walks away
// with the book and the lectern is still filled. That is vanilla creative
// behaviour and not worth fighting.
//
// Wrapped in a function because KubeJS runs every server script in one shared
// scope: two files declaring the same `const` is a redeclaration error, and it
// takes the second file down entirely rather than just the name.
(function () {
  const LgPAC = Java.loadClass('xaero.pac.common.server.api.OpenPACServerAPI')
  const LgPlayerConfig = Java.loadClass('xaero.pac.common.server.player.config.PlayerConfig')
  const LgLectern = Java.loadClass('net.minecraft.world.level.block.LecternBlock')
  const LgStack = Java.loadClass('net.minecraft.world.item.ItemStack')

  // Player UUID -> the book that was on the lectern when they opened it.
  // Only ever holds an entry between an open and its close, and only for
  // lecterns worth guarding.
  const LgWatched = new Map()

  // Where each player last right-clicked a lectern.
  //
  // The menu cannot tell us. Measured on a live server: `menu.getSlot(0).container`
  // is `LecternBlockEntity$1` — the anonymous `Container` the block entity wraps
  // its book in — not the block entity, so it has neither `getBlockPos` nor
  // `getLevel`. Nor does anything else on the path: `this$0` on that container,
  // `blockPos`/`getBlockPos`/`lectern` on the menu, and `block`/`pos` on the
  // KubeJS event all come back undefined or throw. The position has to be caught
  // before the menu exists, and the right-click is the only moment that has it.
  const LgWhere = new Map()

  BlockEvents.rightClicked(event => {
    if (String(event.block.id) !== 'minecraft:lectern') return
    LgWhere.set(String(event.player.uuid), event.block.pos)
  })

  /** True when this position sits on a claim owned by the server itself. */
  const onServerClaim = (server, level, pos) => {
    const claim = LgPAC.get(server).getServerClaimsManager()
      .get(level.dimension, pos)
    return claim != null && claim.getPlayerId().equals(LgPlayerConfig.SERVER_CLAIM_UUID)
  }

  PlayerEvents.inventoryOpened('minecraft:lectern', event => {
    const player = event.player
    const book = event.inventoryContainer.getBook()
    if (book.isEmpty()) return

    const pos = LgWhere.get(String(player.uuid))
    if (pos === undefined) return
    if (!onServerClaim(player.getServer(), player.level, pos)) return

    LgWatched.set(String(player.uuid), book.copy())
  })

  PlayerEvents.inventoryClosed('minecraft:lectern', event => {
    const player = event.player
    const key = String(player.uuid)
    const taken = LgWatched.get(key)
    if (taken === undefined) return
    LgWatched.delete(key)

    if (!event.inventoryContainer.getBook().isEmpty()) return

    const pos = LgWhere.get(key)
    if (pos === undefined) return
    LgWhere.delete(key)
    const level = player.level

    // Prefer the stack the player is actually holding, so the book that goes
    // back is the one that left. The fallback covers the inventory being full
    // at the moment of the take, when vanilla drops the book on the floor
    // instead — the lectern is refilled from the copy and the dropped one is
    // left alone, which is the one case that can end with two.
    const inventory = player.getInventory()
    let restored = false
    for (let i = 0; i < inventory.getContainerSize(); i++) {
      let stack = inventory.getItem(i)
      if (stack.isEmpty() || !LgStack.isSameItemSameComponents(stack, taken)) continue
      restored = LgLectern.tryPlaceBook(player, level, pos, level.getBlockState(pos), stack)
      break
    }
    if (!restored) {
      restored = LgLectern.tryPlaceBook(null, level, pos, level.getBlockState(pos), taken.copy())
    }
    if (!restored) return

    inventory.setChanged()
    player.sendSystemMessage(Text.gray('Ta książka zostaje na pulpicie. Możesz ją czytać, ile chcesz.'))
  })
})()
