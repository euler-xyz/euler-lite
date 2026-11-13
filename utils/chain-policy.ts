import { applyChainRegistry, type ChainIdLists, type ChainRegistry } from './chain-status'

export interface ChainReadPolicy {
  deprecated: boolean
  onchain: boolean
  metadataOnly: boolean
}

export interface ChainPolicyResponse {
  chainId: number
  policy: ChainReadPolicy
}

export interface V3ChainCatalog {
  indexedChainIds: readonly number[]
}

/** Lifecycle controls presentation; V3 support and explicit overrides control reads. */
export const resolveChainPolicy = <T extends ChainIdLists>(
  config: T,
  registry: ChainRegistry,
  isProduction: boolean,
  labelsSource: 'v3' | 'static',
  catalog?: V3ChainCatalog,
) => {
  const admitted = applyChainRegistry(config, registry, isProduction)
  // An unavailable catalog is unknown, never an empty supported-chain list.
  const indexed = catalog && new Set(catalog.indexedChainIds)
  const unindexedChainIds = indexed ? admitted.enabledChainIds.filter(id => !indexed.has(id)) : []
  const metadataOnlyChainIds = labelsSource === 'v3' ? unindexedChainIds : []
  return {
    ...admitted,
    metadataOnlyChainIds,
    onchainSdkChainIds: [...new Set([...admitted.onchainSdkChainIds, ...unindexedChainIds])].sort((a, b) => a - b),
  }
}

export const getChainReadPolicy = (
  config: Pick<ChainIdLists, 'deprecatedChainIds' | 'onchainSdkChainIds'> & { metadataOnlyChainIds?: number[] },
  chainId: number,
): ChainReadPolicy => ({
  deprecated: config.deprecatedChainIds.includes(chainId),
  onchain: config.onchainSdkChainIds.includes(chainId),
  metadataOnly: config.metadataOnlyChainIds?.includes(chainId) ?? false,
})

export const chainReadPolicyKey = (policy: ChainReadPolicy): string =>
  JSON.stringify([policy.deprecated, policy.onchain, policy.metadataOnly])
