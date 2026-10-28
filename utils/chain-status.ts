export type ChainStatus = 'staging' | 'production' | 'unlisted' | 'deprecated'

export interface ChainRegistry {
  /** Admitted deployment IDs; undefined only when the manifest is unavailable. */
  chainIds: readonly number[] | undefined
  statuses: Readonly<Record<number, ChainStatus>>
  explorerUrls: Readonly<Record<number, string>>
}

export interface ChainIdLists {
  enabledChainIds: number[]
  deprecatedChainIds: number[]
  onchainSdkChainIds: number[]
  eVaultFetchChunkChainIds: number[]
}

const CHAIN_STATUSES: readonly ChainStatus[] = ['staging', 'production', 'unlisted', 'deprecated']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// `testing` is the retired name for `staging`; an unknown status hides the chain.
// A missing field is no registry signal, so the env config applies unchanged.
export const parseChainStatus = (value: unknown): ChainStatus | undefined => {
  if (value === undefined) return undefined
  if (value === 'testing') return 'staging'
  return CHAIN_STATUSES.find(status => status === value) ?? 'unlisted'
}

export const parseExplorerUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  }
  catch {
    return undefined
  }
}

interface RegistryEntry {
  chainId: number
  status?: ChainStatus
  explorerUrl?: string
}

const readRegistryEntry = (entry: unknown): RegistryEntry[] => {
  if (!isRecord(entry) || !Number.isInteger(entry.chainId)) return []
  return [{
    chainId: entry.chainId as number,
    status: parseChainStatus(entry.status),
    explorerUrl: parseExplorerUrl(entry.explorerUrl),
  }]
}

export const readChainRegistry = (entries: readonly unknown[] | undefined): ChainRegistry => {
  const parsed = (entries ?? []).flatMap(readRegistryEntry)
  return {
    chainIds: entries === undefined ? undefined : parsed.map(({ chainId }) => chainId),
    statuses: Object.fromEntries(parsed.flatMap(({ chainId, status }) => status ? [[chainId, status]] : [])),
    explorerUrls: Object.fromEntries(parsed.flatMap(({ chainId, explorerUrl }) => explorerUrl ? [[chainId, explorerUrl]] : [])),
  }
}

export const isChainShown = (status: ChainStatus | undefined, isProduction: boolean): boolean =>
  status !== 'unlisted' && !(status === 'staging' && isProduction)

export const getRegistryDeprecatedChainIds = (registry: ChainRegistry): number[] =>
  Object.entries(registry.statuses)
    .filter(([, status]) => status === 'deprecated')
    .map(([chainId]) => Number(chainId))

export const applyChainRegistry = <T extends ChainIdLists>(
  config: T,
  registry: ChainRegistry,
  isProduction: boolean,
): T & { explorerUrls: Record<number, string> } => {
  const admitted = registry.chainIds === undefined ? undefined : new Set(registry.chainIds)
  const enabledChainIds = config.enabledChainIds.filter(id =>
    (!admitted || admitted.has(id)) && isChainShown(registry.statuses[id], isProduction))
  const shown = new Set(enabledChainIds)
  const isShown = (id: number) => shown.has(id)
  const deprecatedChainIds = [...new Set([...config.deprecatedChainIds, ...getRegistryDeprecatedChainIds(registry)])]
    .filter(isShown)
    .sort((a, b) => a - b)

  return {
    ...config,
    enabledChainIds,
    deprecatedChainIds,
    onchainSdkChainIds: config.onchainSdkChainIds.filter(isShown),
    eVaultFetchChunkChainIds: config.eVaultFetchChunkChainIds.filter(isShown),
    explorerUrls: Object.fromEntries(
      Object.entries(registry.explorerUrls).filter(([chainId]) => isShown(Number(chainId))),
    ),
  }
}
