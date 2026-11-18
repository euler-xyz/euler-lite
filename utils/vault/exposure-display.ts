import { getAddress, zeroAddress } from 'viem'
import type { VaultAsset } from '~/types/asset'
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
  kind?: 'uncovered'
}

export const UNCOVERED_EXPOSURE_LABEL = 'Uncovered (bad debt)'
export const UNCOVERED_EXPOSURE_NOTE = 'Debt above its collateral value, counted in Pending bad debt'

const buildUncoveredExposureItem = (valueUsd: number): VaultExposureDisplayItem => ({
  asset: { address: zeroAddress, symbol: 'Uncovered' },
  label: UNCOVERED_EXPOSURE_LABEL,
  valueUsd,
  kind: 'uncovered',
})

const BAD_DEBT_FLOOR_USD = 1
const BAD_DEBT_FLOOR_SHARE = 0.0001

/** Bad debt under max($1, 0.01% of the vault's debt) is rounding noise, not exposure. */
const getUncoveredShareOfDebt = (badDebtUsd: number | undefined, vaultDebtUsd: number): number => {
  if (badDebtUsd === undefined || !Number.isFinite(badDebtUsd) || !Number.isFinite(vaultDebtUsd) || vaultDebtUsd <= 0) return 0
  if (badDebtUsd < Math.max(BAD_DEBT_FLOOR_USD, BAD_DEBT_FLOOR_SHARE * vaultDebtUsd)) return 0
  return Math.min(1, badDebtUsd / vaultDebtUsd)
}

/** The fraction of a vault's supply that a holding of `heldAssets` is, e.g. an Earn allocation. */
export const getHeldSupplyShare = (heldAssets: bigint, totalAssets: bigint): number =>
  totalAssets > 0n && heldAssets > 0n ? Math.min(1, Number(heldAssets) / Number(totalAssets)) : 0

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

/**
 * `badDebtUsd` is the whole vault's V3 bad debt. Open interest is collateral-covered debt from the same
 * snapshot, so bad debt over bad debt plus open interest is the uncovered share of the vault's debt; it
 * applies to the live utilized amount whatever part of the vault `totalExposureUsd` prices.
 */
export const buildAllocatedVaultExposureDisplayItems = ({
  collateralGroups,
  totalExposureUsd,
  utilization,
  badDebtUsd,
}: {
  collateralGroups: CollateralExposureGroup[]
  totalExposureUsd: number
  utilization: number
  badDebtUsd?: number
}): VaultExposureDisplayItem[] => {
  if (!Number.isFinite(totalExposureUsd) || totalExposureUsd <= 0) return []

  const collateralTotalUsd = collateralGroups.reduce((sum, group) => sum + group.openInterestUsd, 0)
  const utilizedExposureUsd = totalExposureUsd * clampPercentFraction(utilization)
  const uncoveredShare = getUncoveredShareOfDebt(badDebtUsd, (badDebtUsd ?? 0) + collateralTotalUsd)
  const coveredExposureUsd = utilizedExposureUsd * (1 - uncoveredShare)
  if (collateralTotalUsd <= 0 && coveredExposureUsd > 0) return []

  // Open interest supplies the USD weighting. Because the split is known here,
  // collaterals with no current exposure ($0) are omitted — they are accepted
  // but not currently backing any borrows, so listing them as $0 rows is noise.
  // (The qualitative fallback, where the split is unknown, still lists every
  // accepted collateral.) Idle (un-utilized) supply is likewise excluded: it is
  // not collateral exposure, so collateral values sum to the utilized amount.
  const collateralItems = collateralGroups
    .map(group => ({
      asset: group.asset,
      valueUsd: collateralTotalUsd > 0
        ? coveredExposureUsd * group.openInterestUsd / collateralTotalUsd
        : 0,
      vaultCount: group.vaultCount,
    }))
    .filter(item => item.valueUsd > 0)

  const items = mergeVaultExposureDisplayItems(collateralItems)
  const uncoveredUsd = utilizedExposureUsd * uncoveredShare
  return uncoveredUsd > 0 ? [...items, buildUncoveredExposureItem(uncoveredUsd)] : items
}

export interface VaultExposureDisplay {
  valueState: ExposureValueState
  items: VaultExposureDisplayItem[]
}

const buildQualitativeExposureDisplay = (collateralGroups: CollateralExposureGroup[]): VaultExposureDisplay => ({
  valueState: 'unavailable',
  items: mergeVaultExposureDisplayItems(
    collateralGroups.map(group => ({
      asset: group.asset,
      valueUsd: 0,
      vaultCount: group.vaultCount,
    })),
  ),
})

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
 *    the allocated builder (collaterals with no current exposure omitted, so a
 *    nothing-utilized vault collapses to an empty list).
 *  - Otherwise → qualitative `unavailable` items listing the backing assets
 *    with zero values, so the UI shows *what* the vault is exposed to even
 *    though the USD split is unknown. This mirrors the pre-open-interest
 *    collateral list.
 *
 * Idle (un-utilized) supply is never listed: it is not collateral exposure.
 *
 * Without open interest the uncovered share needs the vault's whole debt, so the exact split takes
 * known bad debt off only when `vaultShare` says what part of the vault `totalExposureUsd` prices.
 */
export const buildFallbackVaultExposureDisplay = ({
  collateralGroups,
  totalExposureUsd,
  totalSupplyState,
  utilization,
  acceptedCollateralCount,
  badDebtUsd,
  vaultShare,
}: {
  collateralGroups: CollateralExposureGroup[]
  totalExposureUsd: number
  totalSupplyState: ExposureValueState
  utilization: number
  acceptedCollateralCount: number
  badDebtUsd?: number
  vaultShare?: number
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
      // The split is known, so drop collaterals with no current exposure ($0) —
      // same rule as the allocated builder. When nothing is utilized every
      // collateral is $0, so this collapses to an empty ready split ("-").
      const uncoveredShare = vaultShare && vaultShare > 0
        ? getUncoveredShareOfDebt(badDebtUsd, utilizedExposureUsd / vaultShare)
        : 0
      const collateralItems = collateralGroups
        .map(group => ({
          asset: group.asset,
          valueUsd: utilizedExposureUsd > 0 ? utilizedExposureUsd * (1 - uncoveredShare) : 0,
          vaultCount: group.vaultCount,
        }))
        .filter(item => item.valueUsd > 0)
      const items = mergeVaultExposureDisplayItems(collateralItems)
      const uncoveredUsd = utilizedExposureUsd * uncoveredShare

      return {
        valueState: 'ready',
        items: uncoveredUsd > 0 ? [...items, buildUncoveredExposureItem(uncoveredUsd)] : items,
      }
    }
  }

  return buildQualitativeExposureDisplay(collateralGroups)
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
 *
 * `badDebtUsd` is the whole vault's V3 bad debt; while it is still loading the
 * live split waits for it. `vaultShare` is the part of the vault's supply that
 * `totalExposureUsd` prices (1 for the vault itself, an allocation's share for
 * Earn).
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
  badDebtUsd,
  badDebtLoading = false,
  vaultShare,
}: {
  openInterestEnabled: boolean
  openInterestLoaded: boolean
  hasOpenInterestError: boolean
  getCollateralGroups: () => CollateralExposureGroup[]
  totalExposureUsd: number
  totalSupplyState: ExposureValueState
  utilization: number
  acceptedCollateralCount: number
  badDebtUsd?: number
  badDebtLoading?: boolean
  vaultShare?: number
}): VaultExposureDisplay => {
  if (openInterestEnabled && !hasOpenInterestError && !openInterestLoaded) {
    return { valueState: 'loading', items: [] }
  }

  const collateralGroups = getCollateralGroups()
  const hasLiveExposureData = openInterestEnabled && openInterestLoaded && !hasOpenInterestError

  if (hasLiveExposureData && totalSupplyState === 'ready' && badDebtLoading) {
    return { valueState: 'loading', items: [] }
  }

  const collateralTotalUsd = collateralGroups.reduce((sum, group) => sum + group.openInterestUsd, 0)
  const hasUncoveredDebt = getUncoveredShareOfDebt(badDebtUsd, (badDebtUsd ?? 0) + collateralTotalUsd) > 0
  if (
    hasLiveExposureData
    && totalSupplyState === 'ready'
    && (hasUncoveredDebt || !hasMissingUtilizedExposureSplit(collateralGroups, utilization))
  ) {
    return {
      valueState: 'ready',
      items: buildAllocatedVaultExposureDisplayItems({
        collateralGroups,
        totalExposureUsd,
        utilization,
        badDebtUsd,
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
    badDebtUsd,
    vaultShare,
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

export const getExposureLead = (
  display: VaultExposureDisplay,
  limit = 3,
): { assets: ExposureBackingAsset[], label: string } | null => {
  if (display.valueState === 'loading' || !display.items.length) return null
  const covered = sortVaultExposureDisplayItems(display.items.filter(item => item.kind !== 'uncovered'))
  const uncoveredUsd = display.items
    .filter(item => item.kind === 'uncovered')
    .reduce((sum, item) => sum + item.valueUsd, 0)
  const coveredUsd = covered.reduce((sum, item) => sum + item.valueUsd, 0)
  const shown = covered.slice(0, limit)
  const rest = covered.length - shown.length
  const symbols = `${shown.map(item => item.label ?? item.asset.symbol).join(', ')}${rest > 0 ? ` +${rest}` : ''}`
  if (uncoveredUsd > coveredUsd) {
    return {
      assets: shown.map(item => item.asset),
      label: shown.length ? `Mostly uncovered debt; rest backed by ${symbols}` : 'Mostly uncovered debt',
    }
  }
  return {
    assets: shown.map(item => item.asset),
    label: `${display.valueState === 'ready' ? 'Backed by' : 'Accepts'} ${symbols}`,
  }
}

/**
 * The split is built on a nominal supply of one, so only its order and labels are read, never its amounts.
 * With nothing borrowed the split is empty, so the lead names the collaterals a new borrow can use instead.
 */
export const getVaultBackingLead = (
  input: Omit<Parameters<typeof resolveVaultExposureDisplay>[0], 'totalExposureUsd' | 'totalSupplyState'>,
): ReturnType<typeof getExposureLead> => {
  const display = resolveVaultExposureDisplay({ ...input, totalExposureUsd: 1, totalSupplyState: 'ready' })
  const hasNoBorrows = display.valueState === 'ready' && clampPercentFraction(input.utilization) <= 0
  if (!hasNoBorrows) return getExposureLead(display)
  const borrowableGroups = input.getCollateralGroups().filter(group => group.maxBorrowLTV > 0)
  return getExposureLead(buildQualitativeExposureDisplay(borrowableGroups))
}

export interface VaultHeaderAssets {
  assets: VaultAsset[]
  label?: string
}

/** Takes no allocation: the header of an Earn strategy describes the strategy, not this vault's share of it. */
export const getVaultHeaderAssets = (
  vault: { utilization: number, collaterals: readonly unknown[], asset: VaultAsset },
  openInterest: { enabled: boolean, loaded: boolean, hasError: boolean },
  getCollateralGroups: () => CollateralExposureGroup[],
  badDebtUsd?: number,
): VaultHeaderAssets => {
  const lead = getVaultBackingLead({
    openInterestEnabled: openInterest.enabled,
    openInterestLoaded: openInterest.loaded,
    hasOpenInterestError: openInterest.hasError,
    getCollateralGroups,
    utilization: vault.utilization,
    acceptedCollateralCount: vault.collaterals.length,
    badDebtUsd,
  })
  const { address, decimals, name, symbol } = vault.asset
  if (!lead) return { assets: [{ address, decimals, name, symbol }] }
  if (!lead.assets.length) return { assets: [{ address, decimals, name, symbol }], label: lead.label }
  return {
    assets: lead.assets.map(asset => ({ address: getAddress(asset.address), decimals: asset.decimals ?? 18, name: asset.name ?? asset.symbol, symbol: asset.symbol })),
    label: lead.label,
  }
}
