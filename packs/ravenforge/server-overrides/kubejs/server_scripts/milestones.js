// White Ravens Forge — the milestones, and what they pay.
//
// Fifteen advancements in world/datapacks/ravenforge-milestones/ decide WHEN a
// player has done something. This file decides what that is worth and puts the
// money on their account. The split is deliberate: the trigger is data the game
// already knows how to evaluate, the price is a decision, and decisions belong
// somewhere a reviewer can read them in one column.
//
// WHY ADVANCEMENTS AND NOT A TICK LOOP. Every trigger used here is vanilla and
// already fires: changed_dimension for the mine and the five planets,
// inventory_changed for a machine reaching a player's hands,
// player_killed_entity for the dragon. Nothing polls, nothing scans inventories
// on a timer, and the game itself remembers who has already earned what — which
// is what makes "once per player" free rather than another NBT key to maintain.
//
// The hook is NeoForge's AdvancementEvent$AdvancementEarnEvent, which KubeJS
// exposes as PlayerEvents.advancement keyed by the advancement id — measured in
// KubeJSPlayerEventHandler. It fires on the EARN, not on a criterion, so a
// half-finished advancement pays nothing.
//
// THE PAYOUT IS TWO CALLS, NOT ONE, and that is the mod's own convention rather
// than a flourish. EconomyService.deposit moves the number and deliberately
// writes no statement line: banking coins, a shop sale and an operator's
// correction all arrive at deposit looking identical, so the caller says why by
// calling note() itself. `/rc eco add` does exactly this pair, and so does this.
// Without the note the milestone faucet would be invisible on /rc history and
// impossible to tell apart from a shop sale when the supply drifts.
//
// ⚠ Kind.ADJUST is the closest the ledger has, and it is not quite right — it
// means "an operator moved it". The `other` field carries `milestone:<key>` so
// the line is still readable, but a Kind.REWARD in raven-economy would make the
// third faucet countable on its own. That is a small debt, recorded here.
//
// ⚠ REVOKING AN ADVANCEMENT AND EARNING IT AGAIN PAYS AGAIN. `/advancement
// revoke` is the only way to get there and it is an operator action, so this is
// documented rather than guarded — a guard would mean a second store of who has
// been paid, which is the bookkeeping the advancement itself already does.
//
// The amounts are calibrated in docs/shop.txt terms, not picked: one amethyst
// shard is nine RavenCoin, a good geode is about 900 an hour, and the whole
// ladder below comes to 31 500 — roughly 35 hours of that, 11% of the 288 000
// catalogue, and inside the 15 000-40 000 band the file gives for a median
// active player. Nothing here repeats, so no amount of play can turn it into
// the "somebody found a printer" alarm.
//
// The three armour and storage entries were measured before they were priced.
// A MekaSuit piece takes a netherite piece, two polonium pellets, an ultimate
// control circuit, an induction cell and four HDPE sheets — four of those means
// a whole netherite set and a fission reactor actually running, not a casing on
// the ground. A Jet Suit sits on a full netherite space suit plus calorite
// plates, blocks, an engine, a tank and two etrionic capacitors, which is the
// end of Ad Astra's metal ladder. Both are priced level with the top of their
// own branch and neither is bought by the shop at any price.
//
// Wrapped in a function because KubeJS runs every server script in one shared
// scope; see the same note in `rtp.js`.
(function () {
  const MsEconomy = Java.loadClass('net.whiteravens.ravencoin.economy.EconomyService')
  const MsKind = Java.loadClass('net.whiteravens.ravencoin.economy.LedgerEntry$Kind')

  // valueOf rather than the bare field, because it is a method with exactly one
  // signature and cannot be mistaken for anything else by Rhino.
  const MS_ADJUST = MsKind.valueOf('ADJUST')

  // The key is the advancement's file name under ravenforge:milestones/, and
  // `name` is its display title. Both have to match the datapack — scripts/
  // validate.mjs compares the two sides and fails the build if they drift,
  // because an advancement with no row here earns nothing and says nothing, and
  // a row with no advancement never fires. Neither one is visible in a log.
  const MS_MILESTONES = {
    kopalnia: { rc: 100, name: 'Na dół' },
    poradnik: { rc: 200, name: 'Przeczytane' },

    prad: { rc: 400, name: 'Pierwszy prąd' },
    ruda: { rc: 600, name: 'Dwa razy tyle' },
    siec_me: { rc: 800, name: 'Sieć' },
    quarry: { rc: 400, name: 'Maszyna zamiast kilofa' },

    reaktor: { rc: 2000, name: 'Rozszczepienie' },
    sps: { rc: 2000, name: 'Supercritical Phase Shifter' },
    antymateria: { rc: 3000, name: 'Antymateria' },
    mekasuit: { rc: 3000, name: 'Niezniszczalny' },
    smok: { rc: 2000, name: 'Smok' },

    // 2 500 rather than the 3 000 its neighbours get, and the difference is the
    // point: section 4 of docs/shop.txt already buys this cell back for 25 000,
    // so the milestone marks the build rather than paying for it. The three at
    // 3 000 are the ones the shop pays nothing for, ever.
    mega_cell: { rc: 2500, name: 'Przechować cały świat' },

    ksiezyc: { rc: 1500, name: 'Księżyc' },
    mars: { rc: 2000, name: 'Mars' },
    wenus: { rc: 2500, name: 'Wenus' },
    merkury: { rc: 2500, name: 'Merkury' },
    glacio: { rc: 3000, name: 'Glacio' },
    jetsuit: { rc: 3000, name: 'Iron Man' },
  }

  // Thousands separated by a space, which is how Polish writes them and how
  // docs/shop.txt writes every price in the pack.
  const msFormat = amount => String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

  const msPay = (player, key) => {
    const milestone = MS_MILESTONES[key]
    // getServer() off the level rather than the player's field, which is the
    // route rtp.js and mine_warp.js already take. The uuid comes off the
    // GameProfile because Rhino does not expose Entity.getUUID() at all.
    const server = player.level.getServer()
    const uuid = player.getGameProfile().getId()
    const username = player.getGameProfile().getName()

    const result = MsEconomy.deposit(server, uuid, username, milestone.rc)
    if (!result.ok()) {
      console.error('[ravenforge] milestone ' + key + ': RavenCoin refused '
        + milestone.rc + ' for ' + username + ' — ' + result)
      player.sendSystemMessage(Text.red('Nagroda za wyzwanie "' + milestone.name
        + '" nie weszła na konto. Zgłoś to administracji.'))
      return
    }

    MsEconomy.note(server, uuid, MS_ADJUST, milestone.rc, 'milestone:' + key)
    player.sendSystemMessage(Text.green('Wyzwanie "' + milestone.name + '": +'
      + msFormat(milestone.rc) + ' RavenCoin na konto. Stan konta: '
      + msFormat(MsEconomy.balance(server, uuid)) + '.'))
  }

  // forEach rather than a for loop on purpose: a `const` declared inside a loop
  // body binds once in KubeJS's shared scope and every handler would close over
  // the last key. A callback parameter is a fresh binding per call.
  Object.keys(MS_MILESTONES).forEach(key => {
    PlayerEvents.advancement('ravenforge:milestones/' + key, event => {
      try {
        msPay(event.player, key)
      } catch (error) {
        console.error('[ravenforge] milestone ' + key + ' failed to pay: ' + error)
      }
    })
  })
})()
