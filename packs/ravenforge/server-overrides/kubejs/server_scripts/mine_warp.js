// White Ravens Forge — the mine warp, kept correct without anyone typing it.
//
// The mine has no portal. The only way in is the warp, so the warp has to be
// right the moment the dimension comes back after a reset. `/setwarp` cannot
// do that from a schedule: measured in henny-essentials 1.0.4-H3, its
// `executeSetWarp` starts with `getPlayerOrException()` and reads position,
// dimension and rotation off that player. There is no coordinate form.
//
// So this script writes the warp itself. Warps are `SavedData` under the name
// `hennyessentials-warps`, taken from the OVERWORLD's data storage
// (`getWarpData` calls `server.overworld().getDataStorage()`), which is why
// they live in `world/data/` and survive the mine being deleted. `addWarp`
// lowercases the name, replaces any warp already under it, and calls
// `setDirty()` — so re-running this is idempotent.
//
// It runs on every start, not only after a reset. The platform sits at the
// first air above ground at 0/0, and that y is whatever the terrain generator
// decided this cycle; re-reading it costs one chunk for a few seconds and means
// the warp can never drift from the platform.
//
// Wrapped in a function because KubeJS runs every server script in one shared
// scope; see the same note in `claim_guard.js`.
(function () {
  const MwPos = Java.loadClass('net.minecraft.core.BlockPos')
  const MwWarpData = Java.loadClass('com.henny.hennyessentials.data.WarpData')
  const MwWarp = Java.loadClass('com.henny.hennyessentials.data.objects.Warp')

  // Defined by the `ravenforge-mining` datapack that ships beside this file.
  const MW_DIM = 'ravenforge:mining'
  const MW_NAME = 'kopalnia'

  // The datapack's own "this dimension is not fresh" marker, at the top of the
  // build limit where the generator never puts anything. Its presence is the
  // only honest signal that the platform is finished — the chunk being loaded
  // is not, because the chunk loads before `generate` runs.
  const MW_MARKER_Y = 319
  const MW_PROBE_Y = 64

  // The platform is the only thing standing at 0/0 in an air column, so the
  // first solid block on the way down is its floor. 200 is far above any
  // vanilla surface and far below the marker.
  const MW_SCAN_TOP = 200

  const MW_EVERY = 20
  const MW_GIVE_UP = 150

  let mwTicks = 0
  let mwTries = 0
  let mwArmed = false
  let mwForced = false

  const mwLevel = server => {
    // `server.getLevel(key)` is ambiguous to Rhino — KubeJS adds an overload and
    // the call fails with "The choice of Java method ... is ambiguous". Walking
    // the levels avoids the overload entirely, and `dimension` is a property
    // that already prints as the plain id. Note that `String(level)` is NOT a
    // way to tell levels apart: every one of them prints `ServerLevel[world]`.
    var found = null
    var seen = null
    const levels = server.getAllLevels().iterator()
    while (levels.hasNext()) {
      seen = levels.next()
      if (String(seen.dimension) === MW_DIM) found = seen
    }
    return found
  }

  /** y of the platform floor, or null when the column is empty. */
  const mwPlatformTop = level => {
    var y = MW_SCAN_TOP
    var bottom = level.getMinBuildHeight()
    while (y > bottom) {
      if (!level.getBlockState(new MwPos(0, y, 0)).isAir()) return y
      y--
    }
    return null
  }

  /** True when the work is finished and the poller should stand down. */
  const mwStep = server => {
    const level = mwLevel(server)
    if (level == null) {
      console.error('[ravenforge] mine warp: no ' + MW_DIM + ' level — datapack missing?')
      return true
    }

    if (!level.isLoaded(new MwPos(0, MW_PROBE_Y, 0))) {
      // The datapack forceloads this chunk too, and drops it the moment the
      // platform is up. Re-asserting it every poll is what keeps the chunk
      // around long enough to read, and `setChunkForced` is idempotent.
      level.setChunkForced(0, 0, true)
      mwForced = true
      return false
    }

    if (String(level.getBlockState(new MwPos(0, MW_MARKER_Y, 0)).getBlock().getDescriptionId())
        !== 'block.minecraft.barrier') {
      return false
    }

    const top = mwPlatformTop(level)
    if (top == null) {
      console.error('[ravenforge] mine warp: marker is set but 0/0 is an empty column')
      return true
    }

    // Henny teleports to `BlockPos.getCenter()`, so the stored position has to
    // be the air the player stands IN, not the floor they stand ON. `/setwarp`
    // stores `getOnPos()` — the floor — and lands the player half inside it;
    // the collision push-out hides it. We do not copy that.
    const stand = new MwPos(0, top + 1, 0)
    const data = MwWarpData.getWarpData(server)
    const existing = data.warps.get(MW_NAME)

    if (existing != null && String(existing.dimension) === MW_DIM && existing.blockPos.equals(stand)) {
      console.info('[ravenforge] mine warp: "' + MW_NAME + '" already at ' + stand)
      return true
    }

    data.addWarp(new MwWarp(MW_NAME, stand, MW_DIM))
    console.info('[ravenforge] mine warp: "' + MW_NAME + '" set to ' + stand + ' in ' + MW_DIM
      + (existing == null ? ' (was missing)' : ' (was ' + existing.blockPos + ')'))
    return true
  }

  const mwStandDown = server => {
    mwArmed = false
    if (mwForced) {
      const level = mwLevel(server)
      if (level != null) level.setChunkForced(0, 0, false)
      mwForced = false
    }
  }

  ServerEvents.loaded(event => {
    mwTicks = 0
    mwTries = 0
    mwArmed = true
    mwForced = false
  })

  ServerEvents.tick(event => {
    if (!mwArmed) return
    mwTicks++
    if (mwTicks % MW_EVERY !== 0) return

    // A throw here would repeat every second until the give-up count runs out,
    // so it stands the poller down instead of filling the log.
    try {
      mwTries++
      if (mwStep(event.server)) {
        mwStandDown(event.server)
        return
      }
      if (mwTries >= MW_GIVE_UP) {
        console.error('[ravenforge] mine warp: gave up after ' + mwTries
          + ' tries — platform never appeared at 0/0 in ' + MW_DIM)
        mwStandDown(event.server)
      }
    } catch (error) {
      console.error('[ravenforge] mine warp failed: ' + error)
      mwStandDown(event.server)
    }
  })
})()
