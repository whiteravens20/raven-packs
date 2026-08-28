# Runs once per lifetime of the dimension, positioned on the first air block
# above the ground at 0/0. Everything here is relative to that.
#
# 13x13, because 12x12 has no middle block and a 5x5 platform cannot be
# centred in it.
fill ~-6 ~ ~-6 ~6 ~7 ~6 minecraft:air
fill ~-6 ~-1 ~-6 ~6 ~-1 ~6 minecraft:stone
# Two courses of fill underneath, so the platform does not hang over a cave,
# a lake or a lava pocket. `replace` leaves the natural stone alone.
fill ~-6 ~-3 ~-6 ~6 ~-2 ~6 minecraft:stone replace minecraft:air
fill ~-6 ~-3 ~-6 ~6 ~-2 ~6 minecraft:stone replace minecraft:water
fill ~-6 ~-3 ~-6 ~6 ~-2 ~6 minecraft:stone replace minecraft:lava
fill ~-2 ~-1 ~-2 ~2 ~-1 ~2 minecraft:smooth_stone
setblock ~-2 ~ ~-2 minecraft:lantern
setblock ~2 ~ ~-2 minecraft:lantern
setblock ~-2 ~ ~2 minecraft:lantern
setblock ~2 ~ ~2 minecraft:lantern
setblock 0 319 0 minecraft:barrier
# The server claim is deliberately NOT here. `oclaims server claim` cannot be
# parsed while the function library loads at server start — OPAC's argument
# parser reads a config value that is not loaded yet, and the whole function
# fails with "Cannot get config value before config is loaded", taking the
# platform with it. Measured: the mine came up with no platform and only an
# ERROR line in the log to say so. It parses fine on a later /reload, which
# makes it worse — it would pass a hand test and fail on the one path that
# matters. The claim belongs to whatever runs the reset; see the pack plan.
