import * as allChains from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'

const isAppKitNetwork = (v: unknown): v is AppKitNetwork =>
  v != null && typeof v === 'object' && 'id' in v && typeof (v as { id: unknown }).id === 'number'

const chainMap = new Map<number, AppKitNetwork>(
  (Object.values(allChains) as unknown[])
    .filter(isAppKitNetwork)
    .map((chain): [number, AppKitNetwork] => [chain.id as number, chain]),
)

// Reverse lookup: chain slug → chainId. Built from both the export key
// (e.g. `monad`, `swellchain`) and the chain's `name` field (e.g. `Monad`,
// `Swellchain`) — both lowercased. Used to redirect legacy URLs that pass
// a chain name in the `network` query param (e.g. `?network=monad`) to the
// canonical numeric chainId.
const nameToChainId = new Map<string, number>()
for (const [key, chain] of Object.entries(allChains)) {
  if (!isAppKitNetwork(chain)) continue
  const id = chain.id as number
  nameToChainId.set(key.toLowerCase(), id)
  if (typeof chain.name === 'string') {
    const nameSlug = chain.name.toLowerCase().replace(/\s+/g, '-')
    if (!nameToChainId.has(nameSlug)) nameToChainId.set(nameSlug, id)
  }
}

// Aliases for legacy slugs that don't match the viem export key or chain name.
// Add here whenever a legacy URL surfaces that isn't auto-resolved.
const LEGACY_CHAIN_ALIASES: ReadonlyMap<string, number> = new Map([
  ['arbitrumone', 42161],
  ['bnbsmartchain', 56],
  ['lineamainnet', 59144],
])

export const getChainIdByName = (name: string): number | undefined => {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '-')
  if (!normalized) return undefined
  return LEGACY_CHAIN_ALIASES.get(normalized) ?? nameToChainId.get(normalized)
}

export const parseChainId = (value: unknown): number | null => {
  const normalized = Array.isArray(value) ? value[0] : value
  if (normalized == null) return null

  if (typeof normalized === 'number') {
    return Number.isFinite(normalized) ? normalized : null
  }

  if (typeof normalized !== 'string') return null

  const parsed = Number.parseInt(normalized, 10)
  if (Number.isFinite(parsed) && String(parsed) === normalized.trim()) {
    return parsed
  }

  return getChainIdByName(normalized) ?? null
}

export const getNetworksByChainIds = (ids: readonly number[]): AppKitNetwork[] =>
  ids.map((id) => {
    const chain = chainMap.get(id)
    if (!chain) {
      throw new Error(`[chainRegistry] Unknown chain ID ${id}. Not found in @reown/appkit/networks.`)
    }
    return chain
  })

export const getChainById = (chainId: number): AppKitNetwork | undefined =>
  chainMap.get(chainId)

export const isKnownChainId = (chainId: number): boolean =>
  chainMap.has(chainId)

export const getKnownChainIds = (ids: readonly number[]): number[] =>
  ids.filter(isKnownChainId)

export const getUnknownChainIds = (ids: readonly number[]): number[] =>
  ids.filter(id => !isKnownChainId(id))

const DEFI_LLAMA_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'Ethereum'],
  [56, 'BSC'],
  [130, 'Unichain'],
  [146, 'Sonic'],
  [239, 'TAC'],
  [1923, 'Swell'],
  [42161, 'Arbitrum'],
  [43114, 'Avalanche'],
  [59144, 'Linea'],
  [60808, 'BOB'],
  [80094, 'Berachain'],
  [8453, 'Base'],
  [9745, 'Plasma'],
])

export const getDefiLlamaChainName = (chainId: number): string | undefined =>
  DEFI_LLAMA_NAMES.get(chainId)
