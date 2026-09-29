import {
  fetchAllPublicLabelPages,
  resolvePublicLabelsVersion,
  type PublicProductLabel,
  type PublicVaultLabel,
} from '@eulerxyz/euler-v2-sdk/public-labels'
import { createTtlCache } from './cache'
import { withWallClock } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { readLabelsSource, readV3LabelsSelection } from './labels-base-url'
import { createPublicLabelsRequest } from './public-labels-source'
import { readResolvedV3ApiUrl } from '~/utils/api-url-env'
import { getEnabledChainIds } from '~/utils/chain-env'
import { getKnownChainIds } from '~/entities/chainRegistry'
import type { CuratorNetworkIndex, CuratorNetworkSummary } from '~/utils/curator-profile'

const cache = createTtlCache<CuratorNetworkIndex>({ ttlMs: 5 * 60_000, maxEntries: 128 })
const inFlight = createInFlightDedup<string, CuratorNetworkIndex>()

export const summarizeCuratorNetworks = (
  entityId: string,
  enabledChainIds: readonly number[],
  products: readonly PublicProductLabel[],
  vaults: readonly PublicVaultLabel[],
): CuratorNetworkSummary[] => {
  const enabled = new Set(enabledChainIds)
  const byChain = new Map<number, CuratorNetworkSummary>()
  const entryFor = (chainId: number) => {
    let entry = byChain.get(chainId)
    if (!entry) {
      entry = { chainId, productCount: 0, earnVaultCount: 0 }
      byChain.set(chainId, entry)
    }
    return entry
  }

  for (const product of products) {
    if (product.entityId === entityId && enabled.has(product.chainId)) {
      entryFor(product.chainId).productCount += 1
    }
  }
  for (const vault of vaults) {
    if (vault.entityId === entityId && vault.vaultType === 'earn' && enabled.has(vault.chainId)) {
      entryFor(vault.chainId).earnVaultCount += 1
    }
  }
  return [...byChain.values()].sort((a, b) => a.chainId - b.chainId)
}

export const getCuratorNetworkIndex = async (entityId: string): Promise<CuratorNetworkIndex> => {
  if (readLabelsSource() === 'static') return { source: 'static', networks: [] }

  const selection = readV3LabelsSelection()
  const enabledChainIds = getKnownChainIds(getEnabledChainIds())
  const key = JSON.stringify([
    readResolvedV3ApiUrl(), selection.labelSet, selection.version, entityId, enabledChainIds,
  ])
  const cached = cache.get(key)
  if (cached) return cached

  return inFlight.run(key, async () => {
    try {
      const result = await withWallClock(async () => {
        const request = createPublicLabelsRequest()
        const version = await resolvePublicLabelsVersion(request, selection.version, selection.labelSet)
        const query = { labelSet: selection.labelSet, version, view: 'resolved', entityId }
        const [products, vaults] = await Promise.all([
          fetchAllPublicLabelPages<PublicProductLabel>(request, '/labels/products', query),
          fetchAllPublicLabelPages<PublicVaultLabel>(request, '/labels/vaults', query),
        ])
        return {
          source: 'v3' as const,
          networks: summarizeCuratorNetworks(entityId, enabledChainIds, products, vaults),
        }
      }, 25_000, `curator networks entity=${entityId}`)
      cache.set(key, result)
      return result
    }
    catch (error) {
      const stale = cache.getStale(key)
      if (stale) return stale
      throw error
    }
  })
}
