# Build if the chunk is there and the platform is not. A fresh chunk takes
# longer than a tick to generate, so this polls itself.
execute in ravenforge:mining if loaded 0 64 0 unless block 0 319 0 minecraft:barrier positioned 0 0 0 positioned over world_surface run function ravenforge:mining/generate
# Done — let the chunk go again. Keeping it loaded would tick the mine in the
# background for a whole month for nobody's benefit.
execute in ravenforge:mining if block 0 319 0 minecraft:barrier run forceload remove 0 0
# Not done — try again in a second.
#
# The loop hangs off the marker, not off `if loaded`, because those two are not
# the same question. Releasing the chunk as soon as it reports loaded assumes
# the build in the line above succeeded; if it ever does not — a heightmap that
# is not final yet makes `positioned over world_surface` fail quietly, and the
# function carries on — the forceload is gone and nothing is left to retry.
# Asking for the marker makes the release and the retry answer the one question
# that matters: is the platform actually there. This is belt and braces, not a
# fix for an observed failure.
execute in ravenforge:mining unless block 0 319 0 minecraft:barrier run schedule function ravenforge:mining/check 20t replace
