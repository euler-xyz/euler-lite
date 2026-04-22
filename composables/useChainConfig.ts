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
import { getEnabledChainIds, getSubgraphUris } from '~/utils/chain-env'

interface ChainConfig {
  enabledChainIds: number[]
  deprecatedChainIds: number[]
  subgraphUris: Record<string, string>
}

let cached: ChainConfig | null = null

function scanEnv(): ChainConfig {
  const enabledChainIds = getEnabledChainIds()
  const subgraphUris = getSubgraphUris()
  const enabledSet = new Set(enabledChainIds)
  const deprecatedChainIds = parseDeprecatedChains(process.env.DEPRECATED_CHAINS, enabledSet)

  return { enabledChainIds, deprecatedChainIds, subgraphUris }
}

export const useChainConfig = (): ChainConfig => {
  if (cached) return cached

  if (import.meta.server) {
    cached = scanEnv()
  }
  /* eslint-disable @typescript-eslint/no-explicit-any -- server-injected window global */
  else if (typeof window !== 'undefined' && (window as any).__CHAIN_CONFIG__) {
    cached = (window as any).__CHAIN_CONFIG__
  /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  else {
    cached = { enabledChainIds: [], deprecatedChainIds: [], subgraphUris: {} }
  }

  return cached!
}
