// White Ravens Forge — the Council of White Ravens.
//
// One hidden advancement, and the only one in the pack that TAKES money rather
// than paying it. A player sitting on half a million RavenCoin without the rank
// that money exists to buy is a joke the server should tell back: the Council
// notices, buys Technik on their behalf, and levies the fee.
//
// WHY THIS IS NOT AN ADVANCEMENT TRIGGER. There is no vanilla trigger for "this
// account holds N", and there could not be — the balance lives in the mod's own
// SavedData, not in anything the game evaluates. So the check is a slow poll and
// the advancement is granted from here, which also means the toast can never
// appear without the purchase behind it.
//
// THE POLL IS CHEAP AND HAS TO BE. EconomyService.balance is a map lookup in
// SavedData, run once per online player every ten seconds — fifteen slots means
// ninety reads a minute. It stops for good on the first terminal answer, so a
// server full of Techniks costs nothing at all after the first sweep.
//
// ORDER OF THE LADDER IS THE INTERESTING CASE. Technik declares
// `"requires": "obywatel"` in config/ravencoin-ranks.json, and Obywatel is a
// PLAYTIME rank — forty hours, unbuyable at any price. So somebody can reach
// half a million before they reach Obywatel, and RankService.buy answers
// OUT_OF_ORDER. That is not a failure and must not be treated as one: the
// Council adjourns, says so once, and the poll keeps running, so the purchase
// goes through by itself on the first sweep after Obywatel lands. Nothing has to
// be typed and the player does not have to come back to it.
//
// The purchase itself is RankService.buy and nothing else. It charges before it
// grants and refunds if the LuckPerms grant fails to save, which is the mod's
// own ordering — reimplementing any of that here would be a second place where
// money and permissions can disagree.
//
// ⚠ THE FEE IS READ, NOT WRITTEN. The price comes back out of the rank
// definition after the purchase, so the decree quotes what was actually taken
// even after somebody edits config/ravencoin-ranks.json. The 150 000 in
// docs/shop.txt is that config's value today, not a constant in this file.
//
// The two gifts are trophies and nothing else, deliberately. docs/shop.txt
// section 5 forbids handing out anything that makes gold, diamond or amethyst,
// and a player at this point needs no help of any other kind — so what the
// Council gives is the paperwork, addressed to them by name, and a bell.
//
// ⚠ TWO COMPONENTS, TWO DIFFERENT SHAPES, measured rather than guessed.
// `custom_name` is DataComponents.CUSTOM_NAME on ComponentSerialization.CODEC,
// so it takes a text component OBJECT. `lore` is ItemLore.CODEC, which is
// ComponentSerialization.FLAT_CODEC.sizeLimitedListOf(256) — flat, so every
// lore line is a STRING holding JSON, exactly like a written book's pages.
// Writing an object there fails to parse and the item arrives with no lore.
//
// Wrapped in a function because KubeJS runs every server script in one shared
// scope; see the same note in `rtp.js`.
(function () {
  const CoEconomy = Java.loadClass('net.whiteravens.ravencoin.economy.EconomyService')
  const CoRanks = Java.loadClass('net.whiteravens.ravencoin.rank.RankService')
  const CoLoc = Java.loadClass('net.minecraft.resources.ResourceLocation')

  const CO_RANK = 'technik'
  const CO_THRESHOLD = 500000
  const CO_EVERY = 200

  const CO_ADVANCEMENT = CoLoc.parse('ravenforge:rada/technik')

  // Set once the Council has nothing further to do for this player — bought,
  // already a Technik, or the rank system is off. Lives in the player's own NBT
  // under KubeJSPersistentData, so it survives a restart the same way the
  // starter kit's cooldown does.
  const CO_DONE = 'ravenforgeRada'

  // Set when the adjournment has been read out. Separate from CO_DONE because
  // the case is not closed: the poll goes on, it just stops repeating itself.
  const CO_ADJOURNED = 'ravenforgeRadaOdroczona'

  // Answers that end the matter. Everything else is worth another sweep:
  // OUT_OF_ORDER clears itself when Obywatel arrives, and INSUFFICIENT_FUNDS or
  // FAILED are transient by definition.
  const CO_FINAL = ['OK', 'ALREADY_OWNED', 'DISABLED', 'NO_PERMISSIONS', 'UNKNOWN_RANK', 'EARNED_ONLY']

  const coFormat = amount => String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

  // A page, and a lore line, are both JSON in a string — so a line break inside
  // one is the two characters backslash-n, written '\\n' here, and never a real
  // newline, which is a syntax error inside a JSON string literal.
  const coPage = lines => '{"text":"' + lines.join('\\n') + '"}'

  const coDecree = (username, price) => ({
    id: 'minecraft:written_book',
    count: 1,
    components: {
      'minecraft:written_book_content': {
        title: 'Dekret Rady',
        author: 'Rada Białych Kruków',
        resolved: true,
        pages: [
          coPage(['DEKRET', '', 'RADY BIAŁYCH KRUKÓW', '', 'w sprawie majątku', 'gracza', '',
                  username]),
          coPage(['Rada, zważywszy stan', 'konta, nadała rangę',
                  'Technik z urzędu.', '', 'Opłaty administracyjne', 'pobrano.', '',
                  'Odwołań nie', 'przewiduje się.']),
          coPage(['Pobrano:', coFormat(price) + ' RavenCoin', '', '', 'Podpisano', '',
                  'Rada Białych Kruków']),
        ],
      },
    },
  })

  const CO_BELL = {
    id: 'minecraft:bell',
    count: 1,
    components: {
      'minecraft:custom_name': { text: 'Dzwon Rady', color: 'gold', italic: false },
      'minecraft:lore': ['{"text":"Bije raz. Rada nie powtarza.","color":"gray","italic":true}'],
    },
  }

  const coHeader = player => {
    player.sendSystemMessage(Text.gold('─────────────────────────────'))
    player.sendSystemMessage(Text.gold('  RADA BIAŁYCH KRUKÓW'))
    player.sendSystemMessage(Text.gold('─────────────────────────────'))
  }

  const coGranted = (player, username, price) => {
    coHeader(player)
    player.sendSystemMessage(Text.white('Rada zebrała się w sprawie Twojego majątku i uznała za'))
    player.sendSystemMessage(Text.white('niestosowne, by gracz tak zamożny pozostawał bez rangi'))
    player.sendSystemMessage(Text.white('Technik. Ranga została nadana z urzędu.'))
    player.sendSystemMessage(Text.white(''))
    player.sendSystemMessage(Text.yellow('  Opłata:    ' + coFormat(price) + ' RavenCoin'))
    player.sendSystemMessage(Text.yellow('  Na koncie: '
      + coFormat(CoEconomy.balance(player.level.getServer(), player.getGameProfile().getId()))
      + ' RavenCoin'))
    player.sendSystemMessage(Text.white(''))
    player.sendSystemMessage(Text.gray('Odwołań nie przewiduje się. Dekret i dzwon czekają w plecaku.'))
    player.give(Item.of(coDecree(username, price)))
    player.give(Item.of(CO_BELL))
  }

  const coAdjourned = player => {
    coHeader(player)
    player.sendSystemMessage(Text.white('Rada rozpatrzyła Twój majątek i odroczyła sprawę: rangi'))
    player.sendSystemMessage(Text.white('Technik nie nadaje się z pominięciem Obywatela, a Obywatela'))
    player.sendSystemMessage(Text.white('się nie kupuje — tylko wysiaduje.'))
    player.sendSystemMessage(Text.white(''))
    player.sendSystemMessage(Text.gray('Wniosek wraca na obrady sam, gdy dopełnisz stażu.'))
  }

  // The price is read back out of the ladder rather than held here, so the
  // decree cannot quote a number the server no longer charges.
  const coPrice = () => {
    const found = CoRanks.find(CO_RANK)
    return found.isPresent() ? found.get().price() : 0
  }

  const coConsider = player => {
    const data = player.persistentData
    if (data.getBoolean(CO_DONE)) return
    if (player.isAdvancementDone(CO_ADVANCEMENT)) {
      data.putBoolean(CO_DONE, true)
      return
    }

    const server = player.level.getServer()
    const uuid = player.getGameProfile().getId()
    if (CoEconomy.balance(server, uuid) < CO_THRESHOLD) return

    const username = player.getGameProfile().getName()
    const price = coPrice()
    const verdict = String(CoRanks.buy(player, CO_RANK))

    if (verdict === 'OK') {
      data.putBoolean(CO_DONE, true)
      player.unlockAdvancement(CO_ADVANCEMENT)
      coGranted(player, username, price)
      console.info('[ravenforge] council: bought ' + CO_RANK + ' for ' + username
        + ' at ' + price)
      return
    }

    if (verdict === 'OUT_OF_ORDER') {
      if (data.getBoolean(CO_ADJOURNED)) return
      data.putBoolean(CO_ADJOURNED, true)
      coAdjourned(player)
      return
    }

    if (CO_FINAL.indexOf(verdict) >= 0) {
      data.putBoolean(CO_DONE, true)
      // ALREADY_OWNED is the ordinary way this ends for somebody who bought the
      // rank themselves and then got rich; the rest mean the rank system is not
      // set up, and an operator should see that once rather than never.
      if (verdict !== 'ALREADY_OWNED') {
        console.warn('[ravenforge] council: stood down for ' + username + ' — ' + verdict)
      }
      return
    }

    console.warn('[ravenforge] council: ' + CO_RANK + ' refused for ' + username
      + ' — ' + verdict + '; will try again')
  }

  let coTicks = 0

  ServerEvents.tick(event => {
    coTicks++
    if (coTicks % CO_EVERY !== 0) return
    try {
      const players = event.server.getPlayerList().getPlayers()
      for (let i = 0; i < players.size(); i++) {
        var player = players.get(i)
        coConsider(player)
      }
    } catch (error) {
      console.error('[ravenforge] council sweep failed: ' + error)
    }
  })
})()
