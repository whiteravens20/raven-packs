# A freshly generated chunk takes longer than a tick, so this polls itself
# until the chunk is there. `if loaded` is vanilla in 1.21.1.
execute in ravenforge:mining unless loaded 0 64 0 run schedule function ravenforge:mining/check 20t replace
# The barrier at the build ceiling is the marker. It is the only signal that
# dies together with the dimension — a scoreboard or a data storage lives in
# the overworld's level data and would survive a wipe, leaving the platform
# unbuilt forever.
execute in ravenforge:mining if loaded 0 64 0 unless block 0 319 0 minecraft:barrier positioned 0 0 0 positioned over world_surface run function ravenforge:mining/generate
# Let the chunk go again. Keeping it loaded would tick the mine in the
# background for a whole month for nobody's benefit.
execute in ravenforge:mining if loaded 0 64 0 run forceload remove 0 0
