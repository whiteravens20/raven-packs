// White Ravens Forge — the starter kit, and the only kit system left.
//
// Both mods that could have carried this are gone. Henny Essentials' kits are
// pinned off in HennyEssentials.json because `/kit <name>` registers no
// requires() at all on the claiming branch — anybody who knows a name takes the
// kit — and the mod has no per-kit node anywhere, so "this kit for Technik
// only" cannot be said. Starter Kit did the first-join kit correctly and
// nothing else: it fires once, off a Collective first-join tag, with no
// cooldown and no second helping. Neither could express "once an hour, and
// again after a death", which is the rule this server wants, so both mods leave
// pack.json and Collective — which was in the pack only for Starter Kit — goes
// with them.
//
// THE COOLDOWN HAS TO SURVIVE A RESTART, which is the one thing that makes this
// different from rtp.js. That file keeps its five-minute cooldown in a plain
// object, which is right for five minutes and wrong for an hour: a restart
// would hand everybody a fresh kit. So the timestamp goes into the player's
// persistent data, which KubeJS writes into the player's own NBT under
// `KubeJSPersistentData` — EntityMixin puts it there in addAdditionalSaveData
// and reads it back in readAdditionalSaveData, so it survives logout, restart
// and a world reload.
//
// A DEATH DOES NOT CLEAR IT BY ITSELF. Measured in KubeJSPlayerEventHandler.
// cloned: on PlayerEvent$Clone it copies the raw persistent data off the old
// player onto the new one unconditionally, death or not. So "again after a
// death" is not something the storage does for free — it is written below, in
// PlayerEvents.respawned.
//
// Coming back from the End is not a death and fires exactly the same two
// events. That is what `endConquered` is for: PlayerRespawnedKubeEvent carries
// the flag straight off PlayerRespawnEvent.isEndConquered(), and killing the
// dragon must not also pay out a kit.
//
// EVERY ITEM IS BUILT FROM AN OBJECT rather than an item string. `Item.of`
// takes both — a string through a Brigadier StringReader and
// DataComponentWrapper.readPatch, an object through ItemStack.CODEC, which is
// `id` / `count` / `components` — and the object form is the one that needs no
// second layer of quoting for a component value. One route for every item in
// the kit, including the one that carries a component, beats two. Traced
// through ItemWrapper.wrapResult in kubejs-neoforge-2101.7.2-build.374.
//
// Wrapped in a function because KubeJS runs every server script in one shared
// scope; see the same note in `rtp.js`.
(function () {
  const KitProvider = Java.loadClass('net.luckperms.api.LuckPermsProvider')

  const KIT_NODE = 'ravenforge.start'
  const KIT_COOLDOWN_MS = 3600000

  // One key, holding the millisecond stamp of the last claim. A missing key and
  // a zero mean the same thing — never claimed, or cleared by a death — because
  // CompoundTag.getLong answers 0 for a key that is not there, and Date.now()
  // minus 0 is past any cooldown. `contains` is only used to tell "has never
  // taken it" apart from "took it and the death cleared it", which is the
  // difference between showing the hint on login and not.
  const KIT_KEY = 'ravenforgeStartKit'

  // Stone tools without a sword and without a hoe, deliberately. This is a kit
  // for getting back to work after a death, not a kit for fighting or farming:
  // a sword would make dying cheap in the one situation where it should not be,
  // and a hoe is a choice about how you want to feed yourself, made once.
  // Bread rather than any other food for the same reason — it stops the hunger
  // bar being the emergency, and stops there.
  const KIT_ITEMS = [
    { id: 'minecraft:stone_pickaxe' },
    { id: 'minecraft:stone_axe' },
    { id: 'minecraft:stone_shovel' },
    { id: 'minecraft:bread', count: 4 },
  ]

  // THE GUIDE IS MODONOMICON'S BOOK, and the item that carries it is plain
  // `modonomicon:modonomicon`. What makes it OUR book is one component.
  // Measured in CreativeModeTabRegistry: the mod's own creative-tab entry is
  // `new ItemStack(ItemRegistry.MODONOMICON)` with `DataComponentRegistry.
  // BOOK_ID` set to the book's id, and nothing else — so that is exactly what
  // this hands out. `book_id` is a bare ResourceLocation string, because
  // DataComponentRegistry builds the type on `ResourceLocation.CODEC`.
  //
  // ⚠ `model` in book.json does NOT choose the item. Modonomicon registers six
  // items (`modonomicon`, four colours, `leaflet`) and `model` only picks the
  // client-side look; every generated book stack is `modonomicon:modonomicon`.
  // Handing out `modonomicon_purple` instead would give a book that renders but
  // is not the one the tab builds.
  //
  // The book itself is a datapack: world/datapacks/ravenforge-guide/.
  // Modonomicon loads books from `data/<ns>/modonomicon/books/<id>/`, splitting
  // the resource path on `/` and taking the FIRST segment as the book id — so
  // the string below and that directory name have to stay in step, and a typo
  // in either yields an item that opens nothing.
  const KIT_BOOK = {
    id: 'modonomicon:modonomicon',
    count: 1,
    components: { 'modonomicon:book_id': 'ravenforge:poradnik' },
  }

  // A permission check must never take the command down with it. Copied in
  // shape from rtp.js, and for the same measured reasons: resolved by uuid
  // through the UserManager because getPlayerAdapter answers false for a player
  // it has no session for, the uuid form because UserManager.getUser is
  // overloaded on UUID and String and Rhino cannot tell those apart when handed
  // a JavaScript string, and the uuid off the GameProfile because Rhino does
  // not expose Entity.getUUID() at all.
  const kitMayUse = player => {
    let user = null
    try {
      user = KitProvider.get().getUserManager().getUser(player.getGameProfile().getId())
    } catch (error) {
      console.error('[ravenforge] start kit: LuckPerms could not answer for '
        + player.getGameProfile().getName() + ' — ' + error)
      return false
    }
    if (user == null) return false
    return user.getCachedData().getPermissionData().checkPermission(KIT_NODE).asBoolean()
  }

  // give() ends in NeoForge's ItemHandlerHelper.giveItemToPlayer, which drops
  // whatever does not fit at the player's feet rather than deleting it — so a
  // full inventory costs nothing here and needs no check of its own.
  const kitHandOut = player => {
    for (let i = 0; i < KIT_ITEMS.length; i++) player.give(Item.of(KIT_ITEMS[i]))
    player.give(Item.of(KIT_BOOK))
  }

  // The body lives in a function of its own so `executes` can wrap it: an
  // exception escaping a Brigadier command reaches the player as "An unexpected
  // error occurred" and reaches the log as nothing at all.
  const kitClaim = context => {
    const source = context.getSource()
    const player = source.getPlayer()
    if (player == null) {
      source.sendFailure(Text.red('Ta komenda jest dla graczy.'))
      return 0
    }
    if (!kitMayUse(player)) {
      source.sendFailure(Text.red('Nie masz uprawnienia do zestawu startowego.'))
      return 0
    }

    const data = player.persistentData
    const waited = Date.now() - data.getLong(KIT_KEY)
    if (waited < KIT_COOLDOWN_MS) {
      source.sendFailure(Text.red('Zestaw startowy znowu za '
        + Math.ceil((KIT_COOLDOWN_MS - waited) / 60000)
        + ' min. Po śmierci dostaniesz go od razu.'))
      return 0
    }

    // Stamped before the items go out, so a failure halfway through hands out a
    // partial kit once rather than a partial kit every second.
    data.putLong(KIT_KEY, Date.now())
    kitHandOut(player)
    player.sendSystemMessage(Text.green('Zestaw startowy w plecaku. Następny za godzinę albo po śmierci.'))
    return 1
  }

  ServerEvents.commandRegistry(event => {
    event.register(event.commands.literal('start').executes(context => {
      try {
        return kitClaim(context)
      } catch (error) {
        console.error('[ravenforge] start kit failed: ' + error)
        context.getSource().sendFailure(Text.red('Zestaw startowy zawiódł. Zgłoś to administracji.'))
        return 0
      }
    }))
  })

  // The kit is claimed, never pushed, so the only thing login has to do is say
  // the command exists — and only to somebody who has never taken it. After the
  // first claim the key is always there, so this goes quiet on its own and
  // nobody is greeted by the same line for a season.
  PlayerEvents.loggedIn(event => {
    try {
      if (event.player.persistentData.contains(KIT_KEY)) return
      event.player.sendSystemMessage(Text.green('Wpisz /start, żeby dostać zestaw startowy i poradnik.'))
    } catch (error) {
      console.error('[ravenforge] start kit login hint failed: ' + error)
    }
  })

  // The death reset. Zero rather than delete, so the login hint stays quiet for
  // somebody who has taken the kit before and simply died.
  PlayerEvents.respawned(event => {
    try {
      if (event.endConquered) return
      const data = event.player.persistentData
      if (!data.contains(KIT_KEY)) return
      if (data.getLong(KIT_KEY) === 0) return
      data.putLong(KIT_KEY, 0)
      event.player.sendSystemMessage(Text.green('Zestaw startowy jest znowu dostępny — wpisz /start.'))
    } catch (error) {
      console.error('[ravenforge] start kit death reset failed: ' + error)
    }
  })
})()
