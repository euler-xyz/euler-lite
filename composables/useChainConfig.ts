/**
 * Provides chain configuration derived from environment variables.
 *
 * On the server, scans process.env directly (for SSR or API routes).
 * On the client, reads from window.__CHAIN_CONFIG__ which is injected
 * by server/plugins/chain-config.ts via the render:html hook.
 *
 * This avoids runtimeConfig (which is frozen in production) and works
 * with runtime-injected env vars (e.g. Doppler on Railway).
 */
import { getConfiguredChainIds, getEnabledChainIds, getSubgraphUris } from '~/utils/chain-env'
import { getUnknownChainIds } from '~/entities/chainRegistry'

interface ChainConfig {
  enabledChainIds: number[]
  deprecatedChainIds: number[]
  subgraphUris: Record<string, string>
}

let cached: ChainConfig | null = null

function warnUnknownChainIds(chainIds: readonly number[]) {
  if (chainIds.length) {
    console.warn(
      `[chainConfig] Ignoring unsupported chain IDs from RPC_URL_<chainId> env vars: ${chainIds.join(', ')}. Add only chains exported by @reown/appkit/networks.`,
    )
  }
}

function normalizeChainConfig(config: ChainConfig): ChainConfig {
  const unknownChainIds = getUnknownChainIds(config.enabledChainIds)
  warnUnknownChainIds(unknownChainIds)

  const enabledChainIds = config.enabledChainIds.filter(id => !unknownChainIds.includes(id))
  const enabledSet = new Set(enabledChainIds)
  const deprecatedChainIds = config.deprecatedChainIds.filter(id => enabledSet.has(id))

  return { ...config, enabledChainIds, deprecatedChainIds }
}

function scanEnv(): ChainConfig {
  warnUnknownChainIds(getUnknownChainIds(getConfiguredChainIds()))

  const enabledChainIds = getEnabledChainIds()
  const subgraphUris = getSubgraphUris()
  const enabledSet = new Set(enabledChainIds)
  const deprecatedChainIds = parseDeprecatedChains(process.env.DEPRECATED_CHAINS, enabledSet)

  return { enabledChainIds, deprecatedChainIds, subgraphUris }
}

export const useChainConfig = (): ChainConfig => {
  if (cached) return cached

  if (import.meta.server) {
    cached = normalizeChainConfig(scanEnv())
  }
  /* eslint-disable @typescript-eslint/no-explicit-any -- server-injected window global */
  else if (typeof window !== 'undefined' && (window as any).__CHAIN_CONFIG__) {
    cached = normalizeChainConfig((window as any).__CHAIN_CONFIG__)
  /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  else {
    cached = { enabledChainIds: [], deprecatedChainIds: [], subgraphUris: {} }
  }

  return cached!
}
