import type { RouteLocationRaw } from 'vue-router'
import type { CollateralExposureBackingAssetSummary, CollateralExposureGroup } from '~/utils/vault/collateral-exposure'
import { normalizeExposureAddress, type ExposureBackingAsset } from '~/utils/vault/exposure-groups'

export type ExposureValueState = 'ready' | 'loading' | 'unavailable'

export interface VaultExposureDisplaySource {
  label: string
  to?: RouteLocationRaw
}

export interface VaultExposureDisplayItem {
  asset: ExposureBackingAsset
  label?: string
  valueUsd: number
  vaultCount?: number
  sources?: VaultExposureDisplaySource[]
}

export const collateralExposureGroupsToDisplayItems = (
  groups: CollateralExposureGroup[],
): VaultExposureDisplayItem[] =>
  groups.map(group => ({
    asset: group.asset,
    valueUsd: group.openInterestUsd,
    vaultCount: group.vaultCount,
  }))

export const collateralExposureSummariesToDisplayItems = (
  summaries: CollateralExposureBackingAssetSummary[],
): VaultExposureDisplayItem[] =>
  summaries.map(summary => ({
    asset: summary.asset,
    valueUsd: summary.openInterestUsd,
    vaultCount: summary.vaultCount,
  }))

export const mergeVaultExposureDisplayItems = (
  items: VaultExposureDisplayItem[],
): VaultExposureDisplayItem[] => {
  const merged = new Map<string, VaultExposureDisplayItem>()

  const mergeSources = (
    left: VaultExposureDisplaySource[] | undefined,
    right: VaultExposureDisplaySource[] | undefined,
  ): VaultExposureDisplaySource[] | undefined => {
    const sourceMap = new Map<string, VaultExposureDisplaySource>()
    for (const source of [...left ?? [], ...right ?? []]) {
      sourceMap.set(`${source.label}:${JSON.stringify(source.to ?? '')}`, source)
    }
    return sourceMap.size ? [...sourceMap.values()] : undefined
  }

  for (const item of items) {
    const key = `${normalizeExposureAddress(item.asset.address)}:${item.label ?? item.asset.symbol}`
    const existing = merged.get(key)
    if (existing) {
      existing.valueUsd += item.valueUsd
      existing.sources = mergeSources(existing.sources, item.sources)
      existing.vaultCount = existing.sources
        ? undefined
        : (existing.vaultCount ?? 1) + (item.vaultCount ?? 1)
      continue
    }

    merged.set(key, {
      ...item,
      vaultCount: item.sources ? undefined : item.vaultCount,
      asset: {
        ...item.asset,
        address: normalizeExposureAddress(item.asset.address),
      },
    })
  }

  return [...merged.values()]
}

const clampPercentFraction = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value / 100 : 0))

export const hasMissingUtilizedExposureSplit = (
  collateralGroups: CollateralExposureGroup[],
  utilization: number,
): boolean => {
  const collateralTotalUsd = collateralGroups.reduce((sum, group) => sum + group.openInterestUsd, 0)
  return collateralTotalUsd <= 0 && clampPercentFraction(utilization) > 0
}

export const buildAllocatedVaultExposureDisplayItems = ({
  collateralGroups,
  totalExposureUsd,
  utilization,
}: {
  collateralGroups: CollateralExposureGroup[]
  totalExposureUsd: number
  utilization: number
}): VaultExposureDisplayItem[] => {
  if (!Number.isFinite(totalExposureUsd) || totalExposureUsd <= 0) return []

  const collateralTotalUsd = collateralGroups.reduce((sum, group) => sum + group.openInterestUsd, 0)
  const utilizedExposureUsd = totalExposureUsd * clampPercentFraction(utilization)
  if (collateralTotalUsd <= 0 && utilizedExposureUsd > 0) return []

  // The accepted-collateral list is the base layer; open interest only
  // supplies the USD weighting. Accepted collaterals with no current open
  // interest still render (at $0) — they remain hypothetical exposure, and
  // dropping them would let backend data decide which accepted collaterals
  // the user sees. Idle (un-utilized) supply is deliberately excluded: it is
  // not collateral exposure, so collateral values sum to the utilized amount.
  const collateralItems = collateralGroups.map(group => ({
    asset: group.asset,
    valueUsd: collateralTotalUsd > 0
      ? utilizedExposureUsd * group.openInterestUsd / collateralTotalUsd
      : 0,
    vaultCount: group.vaultCount,
  }))

  return mergeVaultExposureDisplayItems(collateralItems)
}

export interface VaultExposureDisplay {
  valueState: ExposureValueState
  items: VaultExposureDisplayItem[]
}

/**
 * Build the exposure display when the per-collateral open-interest split is
 * unknown — V3 disabled for the chain, the open-interest fetch failed, or the
 * backend returned no rows for a utilized vault.
 *
 * Everything here is RPC-derived: total supply, utilization, and the set of
 * live collateral backing assets. Two outcomes:
 *
 *  - The split is fully determined without open-interest data when nothing is
 *    utilized, or when the vault accepts a single collateral so all utilized
 *    exposure structurally belongs to it → exact `ready` items, same shape as
 *    the allocated builder.
 *  - Otherwise → qualitative `unavailable` items listing the backing assets
 *    with zero values, so the UI shows *what* the vault is exposed to even
 *    though the USD split is unknown. This mirrors the pre-open-interest
 *    collateral list.
 *
 * Idle (un-utilized) supply is never listed: it is not collateral exposure.
 */
export const buildFallbackVaultExposureDisplay = ({
  collateralGroups,
  totalExposureUsd,
  totalSupplyState,
  utilization,
  acceptedCollateralCount,
}: {
  collateralGroups: CollateralExposureGroup[]
  totalExposureUsd: number
  totalSupplyState: ExposureValueState
  utilization: number
  acceptedCollateralCount: number
}): VaultExposureDisplay => {
  if (totalSupplyState === 'loading') return { valueState: 'loading', items: [] }

  const utilizationFraction = clampPercentFraction(utilization)

  if (totalSupplyState === 'ready' && (!Number.isFinite(totalExposureUsd) || totalExposureUsd <= 0)) {
    return { valueState: 'ready', items: [] }
  }

  if (totalSupplyState === 'ready') {
    const utilizedExposureUsd = totalExposureUsd * utilizationFraction

    // The exact split is only knowable without open-interest data when nothing
    // is utilized, or when the vault *configures* a single collateral so all
    // utilized exposure structurally belongs to it. We require
    // `acceptedCollateralCount === 1`, not just a single live group: a
    // multi-collateral vault can collapse to one live group when another
    // collateral is dropped from the live set (registry miss, or liquidation
    // LTV ramped to 0 while debt is still outstanding), and attributing 100% to
    // the survivor would be wrong. Those degrade to the qualitative list below.
    const isExactlyKnown = utilizedExposureUsd <= 0
      || (collateralGroups.length === 1 && acceptedCollateralCount === 1)
    if (isExactlyKnown) {
      // Accepted collaterals stay listed even with nothing utilized — same
      // base-layer rule as the allocated builder.
      const collateralItems = collateralGroups.map(group => ({
        asset: group.asset,
        valueUsd: utilizedExposureUsd > 0 ? utilizedExposureUsd : 0,
        vaultCount: group.vaultCount,
      }))

      return {
        valueState: 'ready',
        items: mergeVaultExposureDisplayItems(collateralItems),
      }
    }
  }

  const qualitativeItems = mergeVaultExposureDisplayItems(
    collateralGroups.map(group => ({
      asset: group.asset,
      valueUsd: 0,
      vaultCount: group.vaultCount,
    })),
  )

  return { valueState: 'unavailable', items: qualitativeItems }
}

/**
 * Resolve the exposure display for a single vault (or earn strategy) from its
 * open-interest and supply-price states. This is the one decision point shared
 * by the lend/borrow cards, the vault overview, the earn surfaces, and the
 * discovery matrix — it chooses between the live allocated split and the
 * RPC-derived fallback so the branching cannot drift between call sites.
 *
 * `getCollateralGroups` is a thunk so the (non-trivial) grouping work is skipped
 * entirely while open interest is still loading.
 */
export const resolveVaultExposureDisplay = ({
  openInterestEnabled,
  openInterestLoaded,
  hasOpenInterestError,
  getCollateralGroups,
  totalExposureUsd,
  totalSupplyState,
  utilization,
  acceptedCollateralCount,
}: {
  openInterestEnabled: boolean
  openInterestLoaded: boolean
  hasOpenInterestError: boolean
  getCollateralGroups: () => CollateralExposureGroup[]
  totalExposureUsd: number
  totalSupplyState: ExposureValueState
  utilization: number
  acceptedCollateralCount: number
}): VaultExposureDisplay => {
  // Open interest still resolving — show loading before building any groups.
  if (openInterestEnabled && !hasOpenInterestError && !openInterestLoaded) {
    return { valueState: 'loading', items: [] }
  }

  const collateralGroups = getCollateralGroups()
  const hasLiveExposureData = openInterestEnabled && openInterestLoaded && !hasOpenInterestError

  if (
    hasLiveExposureData
    && totalSupplyState === 'ready'
    && !hasMissingUtilizedExposureSplit(collateralGroups, utilization)
  ) {
    return {
      valueState: 'ready',
      items: buildAllocatedVaultExposureDisplayItems({
        collateralGroups,
        totalExposureUsd,
        utilization,
      }),
    }
  }

  // Open-interest split unknown (v3 disabled for the chain, fetch error, missing
  // rows) or the supply price isn't ready — degrade to the RPC-derived fallback.
  return buildFallbackVaultExposureDisplay({
    collateralGroups,
    totalExposureUsd,
    totalSupplyState,
    utilization,
    acceptedCollateralCount,
  })
}

/**
 * Combine per-strategy (or per-vault) exposure displays into one:
 *
 *  - any `loading` → `loading` (a strategy's inputs are still resolving)
 *  - all `ready`   → `ready` with the merged item set
 *  - otherwise     → `unavailable` with the merged item set and values zeroed,
 *    so strategies that resolved exact numbers don't masquerade as a complete
 *    split next to strategies whose split is unknown.
 */
export const combineVaultExposureDisplays = (
  displays: VaultExposureDisplay[],
): VaultExposureDisplay => {
  if (!displays.length) return { valueState: 'ready', items: [] }
  if (displays.some(display => display.valueState === 'loading')) {
    return { valueState: 'loading', items: [] }
  }
  if (displays.every(display => display.valueState === 'ready')) {
    return {
      valueState: 'ready',
      items: mergeVaultExposureDisplayItems(displays.flatMap(display => display.items)),
    }
  }

  return {
    valueState: 'unavailable',
    items: mergeVaultExposureDisplayItems(
      displays.flatMap(display => display.items.map(item => ({ ...item, valueUsd: 0 }))),
    ),
  }
}

export const sortVaultExposureDisplayItems = (
  items: VaultExposureDisplayItem[],
): VaultExposureDisplayItem[] =>
  [...items].sort((a, b) => {
    if (b.valueUsd !== a.valueUsd) return b.valueUsd - a.valueUsd
    return (a.label ?? a.asset.symbol).localeCompare(b.label ?? b.asset.symbol)
  })
