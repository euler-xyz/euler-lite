export const RECENTLY_ADDED_SORT_MIN_USD = 1_000

export const compareRecentlyAddedBoost = (
  aRecentlyAdded: boolean,
  aLiquidityUsd: number,
  bRecentlyAdded: boolean,
  bLiquidityUsd: number,
) => {
  const aBoost = aRecentlyAdded && aLiquidityUsd >= RECENTLY_ADDED_SORT_MIN_USD ? 1 : 0
  const bBoost = bRecentlyAdded && bLiquidityUsd >= RECENTLY_ADDED_SORT_MIN_USD ? 1 : 0
  return bBoost - aBoost
}
