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
