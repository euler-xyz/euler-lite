/**
 * Lite-owned upper bound for one Pyth update batch. The reviewed execution
 * commits to this value; it must not silently follow an SDK default.
 */
export const PYTH_MAX_UPDATE_FEE = 10n ** 16n

export const PYTH_FRESHNESS_POLICY = Object.freeze({
  maximumAgeSeconds: 60,
})
