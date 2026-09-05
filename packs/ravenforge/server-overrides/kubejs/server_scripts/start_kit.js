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
// EVERY ITEM IS BUILT FROM AN OBJECT rather than an item string, and the book
// is the reason. `Item.of` takes both, but the two routes are not equally safe:
// a string is read by a Brigadier StringReader and DataComponentWrapper.
// readPatch, so a page would have to survive SNBT escaping on top of the JSON
// escaping it already needs — two layers of backslashes with no way to test
// them short of booting a server. An object goes to ItemStack.CODEC instead,
// which is `id` / `count` / `components`, and skips SNBT entirely. Traced
// through ItemWrapper.wrapResult in kubejs-neoforge-2101.7.2-build.374.
//
// The book's own shape, read out of WrittenBookContent rather than guessed:
// `title` is capped at 32 characters by Codec.string(0, 32) and a longer one is
// a hard parse failure; a page is a STRING holding a JSON text component, not a
// JSON object, because PAGES_CODEC sits on ComponentSerialization.flatCodec;
// and neither title nor page needs a `{raw: ...}` wrapper, because
// Filterable.codec is a withAlternative that accepts the bare value.
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

  // A page is a JSON text component in a string, so a line break inside it is
  // the two characters backslash-n and not a real newline — a raw newline
  // inside a JSON string literal is a parse error. Written as '\\n' here, which
  // is those two characters and nothing more.
  const kitPage = lines => '{"text":"' + lines.join('\\n') + '"}'

  // What a new player cannot work out from the game, in the order they meet it.
  // Every fact here is one this pack actually sets: the commands are the ones
  // `nowy` holds in luckperms/yaml-storage/groups/nowy.yml, the claim and home
  // numbers are that file's, the mine's warp name is mine_warp.js's, and the
  // gated blocks are mining_gate.js's list. The forceload page exists because
  // docs/ranks.txt asks for it by name: in a technical pack, machines stopping
  // when you log out is the surprise that costs somebody a night's work.
  //
  // Deliberately absent: the size of the world border. docs/world.txt sets it
  // by hand on a live server and the pack ships no number, so printing one here
  // would be a promise about a setting this file cannot see.
  const KIT_BOOK = {
    id: 'minecraft:written_book',
    count: 1,
    components: {
      'minecraft:written_book_content': {
        title: 'Poradnik startowy',
        author: 'Białe Kruki',
        resolved: true,
        pages: [
          kitPage([
            'BIAŁE KRUKI', 'Forge', '',
            'Poradnik startowy', '',
            'Zestaw bierzesz', 'komendą /start.', '',
            'Raz na godzinę,', 'a po śmierci', 'od razu.',
          ]),
          kitPage([
            'KOMENDY', '',
            '/start - zestaw', '/spawn - na spawn', '/rtp - losowo',
            '/sethome, /home', '/delhome', '/listhomes', '/back',
            '/warp, /warps', '/rules, /playtime', '/afk',
          ]),
          kitPage([
            'DOM', '',
            '/sethome stawia dom', 'tam gdzie stoisz,', '/home wraca.', '',
            'Nowy ma jeden dom.', 'Gracz dwa,', 'Obywatel trzy.',
          ]),
          kitPage([
            'DZIAŁKI', '',
            'Teren zajmujesz', 'mapą Xaero - Open', 'Parties and Claims.', '',
            'Nowy ma 4 chunki.', 'Chunk to 16x16', 'na całą wysokość.',
            'Pokaże go F3+G.', '', 'Nie muszą się', 'stykać.',
          ]),
          kitPage([
            'MASZYNY W NOCY', '',
            'Chunk trzymany', 'w ruchu działa', 'tylko gdy jesteś', 'online.', '',
            'Gdy się wylogujesz,', 'wszystko staje.', '',
            'Nowy ma 0 takich', 'chunków.',
          ]),
          kitPage([
            'KOPALNIA', '',
            '/warp kopalnia', '',
            'Co trzydzieści dni', 'jest kasowana', 'i robi się od nowa.',
            'Nie buduj tam nic', 'na stałe.', '',
            'Quarry i TNT', 'działają tylko tam.',
          ]),
          kitPage([
            'RANGI', '',
            'Nowy', 'Gracz - 10 h gry', 'Obywatel - 40 h gry',
            'Technik - za', 'RavenCoin', '',
            'Gracza i Obywatela', 'dostajesz sam,', 'za czas w grze.',
            'Nikt ich nie', 'sprzedaje.',
          ]),
          kitPage([
            'GRANICA ŚWIATA', '',
            'Świat ma granicę', 'i nie da się jej', 'przelecieć - to',
            'ściana bez końca', 'w górę.', '',
            'Jetpack, Meka-Suit', 'i Jet Suit też', 'się o nią',
            'zatrzymają.',
          ]),
        ],
      },
    },
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
