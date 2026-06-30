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

export const sortVaultExposureDisplayItems = (
  items: VaultExposureDisplayItem[],
): VaultExposureDisplayItem[] =>
  [...items].sort((a, b) => {
    if (b.valueUsd !== a.valueUsd) return b.valueUsd - a.valueUsd
    return (a.label ?? a.asset.symbol).localeCompare(b.label ?? b.asset.symbol)
  })
