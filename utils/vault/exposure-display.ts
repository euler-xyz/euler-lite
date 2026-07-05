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
  idleAsset,
  utilization,
  idleSource,
}: {
  collateralGroups: CollateralExposureGroup[]
  totalExposureUsd: number
  idleAsset: ExposureBackingAsset
  utilization: number
  idleSource?: VaultExposureDisplaySource
}): VaultExposureDisplayItem[] => {
  if (!Number.isFinite(totalExposureUsd) || totalExposureUsd <= 0) return []

  const collateralTotalUsd = collateralGroups.reduce((sum, group) => sum + group.openInterestUsd, 0)
  const utilizedExposureUsd = totalExposureUsd * clampPercentFraction(utilization)
  if (collateralTotalUsd <= 0 && utilizedExposureUsd > 0) return []

  const collateralItems = collateralTotalUsd > 0
    ? collateralGroups
        .filter(group => group.openInterestUsd > 0)
        .map(group => ({
          asset: group.asset,
          valueUsd: utilizedExposureUsd * group.openInterestUsd / collateralTotalUsd,
          vaultCount: group.vaultCount,
        }))
    : []

  const idleExposureUsd = Math.max(0, totalExposureUsd - utilizedExposureUsd)
  const idleItems: VaultExposureDisplayItem[] = idleExposureUsd > 0
    ? [{
        asset: idleAsset,
        label: `${idleAsset.symbol} Idle`,
        valueUsd: idleExposureUsd,
        vaultCount: idleSource ? undefined : 1,
        sources: idleSource ? [idleSource] : undefined,
      }]
    : []

  return mergeVaultExposureDisplayItems([...collateralItems, ...idleItems])
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
 *    utilized or when a single backing asset backs all utilized exposure →
 *    exact `ready` items, same shape as the allocated builder.
 *  - Otherwise → qualitative `unavailable` items listing the backing assets
 *    (and idle, when utilization leaves room for it) with zero values, so the
 *    UI shows *what* the vault is exposed to even though the USD split is
 *    unknown. This mirrors the pre-open-interest collateral list.
 */
export const buildFallbackVaultExposureDisplay = ({
  collateralGroups,
  totalExposureUsd,
  totalSupplyState,
  idleAsset,
  utilization,
  idleSource,
}: {
  collateralGroups: CollateralExposureGroup[]
  totalExposureUsd: number
  totalSupplyState: ExposureValueState
  idleAsset: ExposureBackingAsset
  utilization: number
  idleSource?: VaultExposureDisplaySource
}): VaultExposureDisplay => {
  if (totalSupplyState === 'loading') return { valueState: 'loading', items: [] }

  const utilizationFraction = clampPercentFraction(utilization)
  const buildIdleItem = (valueUsd: number): VaultExposureDisplayItem => ({
    asset: idleAsset,
    label: `${idleAsset.symbol} Idle`,
    valueUsd,
    vaultCount: idleSource ? undefined : 1,
    sources: idleSource ? [idleSource] : undefined,
  })

  if (totalSupplyState === 'ready' && (!Number.isFinite(totalExposureUsd) || totalExposureUsd <= 0)) {
    return { valueState: 'ready', items: [] }
  }

  if (totalSupplyState === 'ready') {
    const utilizedExposureUsd = totalExposureUsd * utilizationFraction

    // Deliberate divergence from buildAllocatedVaultExposureDisplayItems,
    // which refuses to attribute utilized exposure when every group's
    // openInterestUsd is 0: with a single live collateral the attribution is
    // structurally determined, so the zero weight carries no information.
    if (utilizedExposureUsd <= 0 || collateralGroups.length === 1) {
      const collateralItems = utilizedExposureUsd > 0
        ? collateralGroups.map(group => ({
            asset: group.asset,
            valueUsd: utilizedExposureUsd,
            vaultCount: group.vaultCount,
          }))
        : []
      const idleExposureUsd = Math.max(0, totalExposureUsd - utilizedExposureUsd)
      const idleItems = idleExposureUsd > 0 ? [buildIdleItem(idleExposureUsd)] : []

      return {
        valueState: 'ready',
        items: mergeVaultExposureDisplayItems([...collateralItems, ...idleItems]),
      }
    }
  }

  const qualitativeItems = mergeVaultExposureDisplayItems([
    ...collateralGroups.map(group => ({
      asset: group.asset,
      valueUsd: 0,
      vaultCount: group.vaultCount,
    })),
    ...(utilizationFraction < 1 ? [buildIdleItem(0)] : []),
  ])

  return { valueState: 'unavailable', items: qualitativeItems }
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
