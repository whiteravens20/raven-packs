# Runs on every server start and every /reload. Holding the chunk is the only
# way to ask whether the platform is there: a dimension nobody has visited has
# no loaded chunk to read a block out of.
execute in ravenforge:mining run forceload add 0 0
function ravenforge:mining/check
