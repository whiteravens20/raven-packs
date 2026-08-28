// White Ravens Forge — one-off crafting bans.
//
// Chunk loaders, machines that reach across a claim boundary, firearms, and
// the handful of items that would flatten the currency. Everything here was
// read out of the shipped jars; nothing is written from memory, because a
// misspelled entry in `event.remove` passes without an error and without an
// effect. The counts logged at the bottom are what proves the list still
// matches the jars after a mod update.
//
// Filters go by OUTPUT wherever the ban targets an item. An id list misses
// the extras: AE2's two planes have two recipes each, EnderIO's travel
// anchor can be un-painted back into existence, Silent Gear's prospector
// hammer has a "quick" variant, and every AE2 spatial cell can also be
// assembled from a storage component. Recipe ids are used only where the
// recipe produces no item at all, or produces a fluid.
// Wrapped in a function because KubeJS runs every server script in one shared
// scope: two files declaring the same `const` is a redeclaration error, and it
// takes the second file down entirely rather than just the name. Measured —
// `MINING` was declared here and in the gate, and the gate stopped loading.
(function () {
  const DYES = [
    'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
  ]

  // Laser Drill lenses — the server shop is meant to be their only source,
  // which makes the price list part of the currency balance.
  const LASER_LENSES = DYES.map(c => 'industrialforegoing:' + c + '_laser_lens')

  const BANNED_OUTPUT = LASER_LENSES.concat([
    // Industrial Foregoing's infinity tier: creative-grade tools and a nuke.
    'industrialforegoing:infinity_nuke',
    'industrialforegoing:infinity_drill',
    'industrialforegoing:infinity_hammer',
    'industrialforegoing:infinity_saw',
    'industrialforegoing:infinity_trident',
    'industrialforegoing:infinity_launcher',
    'industrialforegoing:infinity_backpack',
    'industrialforegoing:infinity_charger',

    // Mekanism. The anchor upgrade is a chunk loader in an upgrade slot.
    'mekanism:digital_miner',
    'mekanism:meka_tool',
    'mekanism:flamethrower',
    'mekanism:upgrade_anchor',

    // AE2. The two planes are cable parts, so BlockEvents.placed never sees
    // them and the area guard cannot cover them — the ban is all there is.
    'ae2:matter_cannon',
    'ae2:spatial_anchor',
    'ae2:spatial_io_port',
    'ae2:spatial_pylon',
    'ae2:spatial_storage_cell_2',
    'ae2:spatial_storage_cell_16',
    'ae2:spatial_storage_cell_128',
    'ae2:annihilation_plane',
    'ae2:formation_plane',

    // EnderIO — teleportation and weather control.
    'enderio:travel_anchor',
    'enderio:painted_travel_anchor',
    'enderio:staff_of_travelling',
    'enderio:weather_obelisk',
    'enderio:staff_of_levity',

    // QuarryPlus. The quarry itself stays; these are the parts that make it
    // ignore bedrock, place blocks remotely, or run at an unbounded rate.
    'quarryplus:adv_quarry',
    'quarryplus:remove_bedrock_module',
    'quarryplus:placer_plus',
    'quarryplus:remote_placer',
    'quarryplus:repeat_tick_module',

    // Railcraft — chunk loaders, and the three track tools that rewrite blocks
    // through `setBlockAndUpdate`, which OPAC cannot see.
    'railcraft:world_spike',
    'railcraft:personal_world_spike',
    'railcraft:world_spike_minecart',
    'railcraft:track_remover',
    'railcraft:track_relayer',
    'railcraft:track_undercutter',

    // Immersive Engineering — turrets and firearms.
    'immersiveengineering:turret_gun',
    'immersiveengineering:turret_chem',
    'immersiveengineering:tesla_coil',
    'immersiveengineering:revolver',
    'immersiveengineering:railgun',
    'immersiveengineering:chemthrower',
    'immersiveengineering:gunpart_barrel',
    'immersiveengineering:gunpart_drum',
    'immersiveengineering:gunpart_hammer',
    'immersiveengineering:toolupgrade_revolver_bayonet',
    'immersiveengineering:toolupgrade_revolver_electro',
    'immersiveengineering:toolupgrade_revolver_magazine',
    'immersiveengineering:toolupgrade_railgun_capacitors',
    'immersiveengineering:toolupgrade_railgun_scope',
    'immersiveengineering:toolupgrade_chemthrower_focus',
    'immersiveengineering:toolupgrade_chemthrower_multitank',

    // Ammunition, and the casing and mould it is built from.
    'immersiveengineering:bullet_armor_piercing',
    'immersiveengineering:bullet_buckshot',
    'immersiveengineering:bullet_casull',
    'immersiveengineering:bullet_dragons_breath',
    'immersiveengineering:bullet_firework',
    'immersiveengineering:bullet_flare',
    'immersiveengineering:bullet_he',
    'immersiveengineering:bullet_homing',
    'immersiveengineering:bullet_potion',
    'immersiveengineering:bullet_silver',
    'immersiveengineering:bullet_wolfpack',
    'immersiveengineering:empty_casing',
    'immersiveengineering:mold_bullet_casing',

    // The Resonanz Observer block. It appears in exactly one multiblock
    // template — IE's chunk loader — and has exactly one recipe, so banning
    // the block is enough to stop the multiblock from ever forming. IE has no
    // config for that, and this is cheaper than fighting the template.
    'immersiveengineering:resonanz_engineering',

    // Immersive Petroleum — the molotov. Napalm is a fluid and goes by id.
    'immersivepetroleum:molotov',

    // Blast strength 6, stronger than TNT, and its only real use is summoning
    // the dragon — which is the server's job, not a player's (D20).
    'minecraft:end_crystal',
  ])

  const BANNED_ID = [
    // Recipes that produce no item, so there is no output to filter on.
    'immersiveengineering:revolver_cycle',
    'immersiveengineering:flare_bullet_color',
    'immersiveengineering:potion_bullet_fill',
    // Produces a fluid.
    'immersivepetroleum:mixer/napalm',
    // Silent Gear. The prospector hammer is an ore scanner; the elytra keeps
    // the End an actual stage rather than a shortcut. These go by id because
    // an output filter finds nothing on `silentgear:gear_crafting` and
    // `silentgear:compound_part` — measured, unlike Industrial Foregoing's
    // dissolution chamber and Mekanism's `mek_data`, which output filters do
    // reach. QuarryPlus's `install_bedrock_module_quarry` is deliberately
    // absent: the mod already ships it behind a `neoforge:false` condition,
    // so it never loads and there is nothing to remove.
    'silentgear:gear/prospector_hammer',
    'silentgear:gear/prospector_hammer_quick',
    'silentgear:gear/prospector_hammer_head',
    'silentgear:gear/elytra',
    'silentgear:gear/elytra_wings',
  ]

  // Piglins barter gold without limit and zombified piglins farm it, which is
  // the one item sink the currency cannot survive. The datapack already takes
  // the ingot out of the zombified piglin's loot table; this closes bartering.
  const NO_SPAWN = ['minecraft:piglin', 'minecraft:zombified_piglin', 'minecraft:piglin_brute']

  ServerEvents.recipes(event => {
    let removed = 0
    const missed = []

    const ban = (filter, label) => {
      const n = event.countRecipes(filter)
      if (n === 0) {
        missed.push(label)
        return
      }
      event.remove(filter)
      removed += n
    }

    BANNED_OUTPUT.forEach(item => ban({ output: item }, item))
    BANNED_ID.forEach(id => ban({ id: id }, id))

    console.info('[ravenforge] bans: ' + removed + ' recipes removed, '
      + (BANNED_OUTPUT.length + BANNED_ID.length - missed.length) + ' of '
      + (BANNED_OUTPUT.length + BANNED_ID.length) + ' filters matched')
    if (missed.length > 0) {
      console.warn('[ravenforge] bans matched nothing — renamed or gone: ' + missed.join(', '))
    }
  })

  NO_SPAWN.forEach(type => {
    EntityEvents.checkSpawn(type, event => {
      event.cancel()
    })
  })
})()
