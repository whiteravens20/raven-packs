// White Ravens Forge — the rank guard.
//
// ravenclassic stops a Moderator banning an Administrator with
// `minecraft.selector.weight.*`, and that node comes from Vanilla Permissions,
// which is Fabric-only. Nothing on NeoForge supplies it. CustomPerm, the one
// NeoForge mod that gates commands behind permission nodes, has no selector,
// weight or target-protection code in its jar at all — a Moderator given /ban
// there could ban the owner. So this half has to be written rather than
// installed, and it is the half that decides whether a staff column can exist.
//
// It hangs off CommandEvent, which NeoForge fires from Commands.performCommand
// after parsing and before execution. Three things follow, all measured on a
// live server rather than assumed:
//
//   - Cancelling stops the command, and the event fires for operators too. The
//     control ran from the level-4 console: without the cancel /seed printed
//     the seed, with it nothing. An op is exactly who this guards against.
//   - A parse that FAILED still reaches the event, and `getCommandName()` is
//     then empty because there is no command node to name. The command has to
//     be read out of the raw input.
//   - A handler on ServerEvents.command that throws IS logged, as
//     "Error in 'ServerEvents.command': ...". Commands registered through
//     commandRegistry are not — Brigadier swallows those, which is why
//     rtp.js wraps its body by hand and this file does not need to.
//   - The source carries the actor, so `getPlayer()` is the player or null.
//     Null is the console and command blocks, and both are left alone: the
//     console is the owner's own channel, and a command block cannot be placed
//     without op in the first place.
//
// Weight comes from LuckPerms. A group's `weight.<n>` permission is what
// `Group.getWeight()` returns, and a player's weight is the highest among the
// groups they inherit, so these are the numbers the ladder ships in
// config/luckperms/yaml-storage/groups/.
//
// What it does NOT cover, stated so nobody assumes otherwise: a command that
// harms someone without naming them. `lp group gracz parent add technik` edits
// a whole rank and mentions no player, which is why group names are checked
// below as well as player names — but a mod command that takes a target by
// uuid still slips past. The guard is a floor, not a proof.
// Wrapped in a function because KubeJS runs every server script in one shared
// scope: two files declaring the same `const` is a redeclaration error, and it
// takes the second file down entirely rather than just the name. Measured —
// `MINING` was declared here and in the gate, and the gate stopped loading.
//
// The same scope has a sharper edge, measured while writing this file: an
// identifier used as a helper's parameter collides with the same identifier
// declared inside another callback, across files, and only when the callback
// RUNS — the scripts load clean and the failure surfaces later as
// "redeclaration of var <name>". Hence one lazily-resolved handle closed over
// by every helper here, rather than a `perms` argument threaded through them,
// and loop variables declared at function-body level rather than in the loop.
(function () {
  const LuckPermsProvider = Java.loadClass('net.luckperms.api.LuckPermsProvider')

  // Commands that act ON another person. Everything a staff member could turn
  // against another staff member belongs here; a command that only affects the
  // caller does not, because the self exemption below would pass it anyway.
  //
  // `lp` and `luckperms` matter most — a rank edit outranks every ban in this
  // list, because it hands over everything else permanently.
  //
  // The second block is Henny Essentials, and it is the reason this guard is
  // no longer theoretical. Moderation used to need op, so only the owner could
  // ban anybody and there was nobody to protect; command.he.ban in the
  // moderator group is what opened the hole. Henny's own Ban and Mute never
  // ask what rank their target holds — measured, neither class touches
  // LuckPermsIntegration — so every one of these is unguarded without this.
  //
  // The permission-editing family is listed even though no group holds it.
  // Nothing should ever grant it, and if something one day does by mistake,
  // this is the line that keeps a Moderator from writing themselves a rank.
  //
  // Self-only commands are deliberately absent: heal, feed, fly, vanish and
  // repair have no ".other" node in Henny's jar, so they cannot reach anyone
  // else and the self exemption below would wave them through anyway.
  const GUARDED = [
    // vanilla
    'ban', 'ban-ip', 'kick', 'pardon', 'pardon-ip',
    'op', 'deop', 'whitelist',
    'tp', 'teleport', 'spectate',
    'gamemode', 'kill', 'clear', 'effect',
    'lp', 'luckperms', 'perms',
    // Henny Essentials
    'tempban', 'unban', 'banuuid', 'unbanuuid',
    'mute', 'tempmute', 'unmute', 'muteuuid',
    'invsee', 'viewechest', 'tpahere',
    'adduserperm', 'removeuserperm', 'adduuidperm', 'removeuuidperm',
    'addgroupperm', 'removegroupperm',
    'adduserprefix', 'removeuserprefix', 'addusersuffix', 'removeusersuffix',
    'addgroupprefix', 'removegroupprefix', 'addgroupsuffix', 'removegroupsuffix',
  ]

  let luckPermsHandle = null
  const luckPerms = () => {
    if (luckPermsHandle == null) luckPermsHandle = LuckPermsProvider.get()
    return luckPermsHandle
  }

  /** Highest weight among the groups this user or group inherits, 0 for none. */
  const weightOfHolder = holder => {
    if (holder == null) return 0
    const contexts = luckPerms().getContextManager()
    const options = contexts.getQueryOptions(holder).orElseGet(() => contexts.getStaticQueryOptions())
    // An explicit iterator: getInheritedGroups returns a Collection, so there
    // is no index to loop over.
    const inherited = holder.getInheritedGroups(options).iterator()
    let highest = 0
    let inheritedWeight = null
    while (inherited.hasNext()) {
      inheritedWeight = inherited.next().getWeight()
      if (inheritedWeight.isPresent() && inheritedWeight.getAsInt() > highest) {
        highest = inheritedWeight.getAsInt()
      }
    }
    return highest
  }

  /**
   * Everything resolves through the UserManager by uuid, online or not.
   * getPlayerAdapter would be the obvious route and it is the wrong one: it
   * computes from session contexts and answers for a player it has no session
   * for by refusing, measured on the rig. The uuid comes off the GameProfile
   * because KubeJS does not expose Entity.getUUID at all — "Cannot find
   * function getUUID" — while GameProfile is plain authlib and is not remapped.
   */
  const weightOfUuid = uuid => {
    const user = luckPerms().getUserManager().getUser(uuid)
    return user == null ? -1 : weightOfHolder(user)
  }

  const weightOfPlayer = player => weightOfUuid(player.getGameProfile().getId())

  // A vanilla username: three to sixteen word characters. Tokens that cannot
  // be a name — coordinates, flags, durations — are skipped without a lookup,
  // which keeps `/tp 100 64 100` from costing three storage queries.
  const NAME_SHAPE = /^[A-Za-z0-9_]{3,16}$/

  /**
   * The uuid behind a name, or null when nobody by that name has ever been
   * seen. LuckPerms keeps its own uuid/name cache and writes to it on every
   * login, so it knows everyone who has ever joined.
   *
   * The vanilla profile cache would do as well, but `GameProfileCache.get` is
   * overloaded on String and UUID and Rhino picks the UUID one for a
   * JavaScript string — it threw "UUID string must be 32 or 36 characters
   * long, got 'TestTechnik'" on the rig. `lookupUniqueId` has one signature
   * and no such trap.
   */
  const uuidForName = name => luckPerms().getUserManager().lookupUniqueId(name).join()

  /**
   * Weight behind a name, or -1 when the name belongs to nobody the server has
   * ever seen — a coordinate, a flag, a group id. Callers read -1 as "not a
   * person, so not this guard's business".
   *
   * Everything here goes through the uuid rather than the name. UserManager
   * offers both getUser(UUID) and getUser(String), and Rhino cannot tell the
   * two apart when handed a JavaScript string: it throws instead of resolving,
   * which silently swallowed the whole check until the rig caught it.
   */
  const weightOfName = (server, name) => {
    const online = server.getPlayerList().getPlayerByName(name)
    if (online != null) return weightOfPlayer(online)
    if (!NAME_SHAPE.test(name)) return -1

    const uuid = uuidForName(name)
    if (uuid == null) return -1

    const known = weightOfUuid(uuid)
    if (known >= 0) return known

    // Blocking the server thread, deliberately. Storage is `yaml` (set in
    // config/luckperms/luckperms.conf), so this is a local file read, and
    // moderation commands are rare. Resolving it asynchronously would mean
    // cancelling first and re-running the command afterwards, which is a
    // re-entrancy bug waiting to happen for no gain at this size.
    const loaded = luckPerms().getUserManager().loadUser(uuid).join()
    const loadedWeight = weightOfHolder(loaded)
    luckPerms().getUserManager().cleanupUser(loaded)
    return loadedWeight
  }

  /** Weight of the group by that name, or -1 when no such group exists. */
  const weightOfGroup = name => {
    const group = luckPerms().getGroupManager().getGroup(name.toLowerCase())
    if (group == null) return -1
    const declared = group.getWeight()
    return declared.isPresent() ? declared.getAsInt() : 0
  }

  /** Highest weight among online players other than the actor. */
  const highestOtherOnline = (server, actor) => {
    const others = server.getPlayerList().getPlayers().iterator()
    let highest = -1
    let other = null
    let otherWeight = 0
    while (others.hasNext()) {
      other = others.next()
      if (other.getGameProfile().getId().equals(actor.getGameProfile().getId())) continue
      otherWeight = weightOfPlayer(other)
      if (otherWeight > highest) highest = otherWeight
    }
    return highest
  }

  ServerEvents.command(event => {
    const typed = String(event.input).replace(/^\//, '')
    const words = typed.split(/\s+/).filter(word => word.length > 0)
    if (words.length === 0) return
    if (GUARDED.indexOf(words[0].toLowerCase()) < 0) return

    const source = event.parseResults.context.source
    const actor = source.getPlayer()
    if (actor == null) return

    const server = source.getServer()
    // ORDER MATTERS AND IT IS NOT OBVIOUS. `event.cancel()` does not set a
    // flag and return — KubeJS implements it by throwing a control-flow
    // exception that unwinds the handler, so NOTHING after it runs. With the
    // cancel first, this guard refused correctly and silently for an entire
    // debugging session: the player was told nothing and the log recorded
    // nothing. Say it, send it, then cancel.
    //
    // sendFailure, not player.tell: `source.getPlayer()` hands back the raw
    // ServerPlayer, which has no KubeJS `tell`.
    const refuse = reason => {
      console.warn('[ravenforge] rank guard refused "' + typed + '" from '
        + actor.getGameProfile().getName() + ': ' + reason)
      source.sendFailure(Text.red(reason))
      event.cancel()
    }

    let actorWeight = 0
    try {
      actorWeight = weightOfPlayer(actor)
    } catch (error) {
      // Without LuckPerms there are no weights, so there is no safe answer for
      // anyone below the top. Level 4 keeps working, because locking the owner
      // out of their own server is the one failure this must never cause.
      if (source.hasPermission(4)) return
      refuse('System rang jest niedostępny — komendy moderacyjne są wstrzymane.')
      console.error('[ravenforge] rank guard: LuckPerms unavailable — ' + error)
      return
    }

    const actorName = String(actor.getGameProfile().getName()).toLowerCase()
    let word = null
    let targetWeight = 0
    let groupWeight = 0

    for (let index = 1; index < words.length; index++) {
      word = words[index]

      // A selector reaches whoever is online, and this guard cannot read who
      // that is before the command runs. @s is the caller, so it is always
      // theirs; anything else is allowed only to someone who already outranks
      // every other player currently connected.
      if (word.charAt(0) === '@') {
        if (word.toLowerCase().indexOf('@s') === 0) continue
        if (highestOtherOnline(server, actor) < actorWeight) continue
        refuse('Selektor ' + word + ' obejmuje kogoś o randze równej Twojej lub wyższej.')
        return
      }

      // Your own name is always yours to pass. Names are compared rather than
      // uuids because that is how commands take a target here.
      if (word.toLowerCase() === actorName) continue

      targetWeight = weightOfName(server, word)
      if (targetWeight >= actorWeight) {
        refuse('Gracz ' + word + ' ma rangę równą Twojej lub wyższą.')
        return
      }

      groupWeight = weightOfGroup(word)
      if (groupWeight >= actorWeight) {
        refuse('Ranga ' + word + ' jest równa Twojej lub wyższa.')
        return
      }
    }
  })
})()
