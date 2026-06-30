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
import { getChainEnvIssues, getConfiguredChainIds, getEnabledChainIds, type ChainEnvIssues } from '~/utils/chain-env'
import { getUnknownChainIds } from '~/entities/chainRegistry'
import { logger } from '~/utils/logger'
import { parseEVaultFetchChunkChainIds } from '~/utils/eVaultFetchChunkConfig'

interface ChainConfig {
  enabledChainIds: number[]
  deprecatedChainIds: number[]
  eVaultFetchChunkChainIds: number[]
  unsupportedChainIds?: number[]
  chainEnvIssues?: ChainEnvIssues
}

let cached: ChainConfig | null = null

function logUnknownChainIds(chainIds: readonly number[]) {
  if (chainIds.length) {
    logger.error(
      { ctx: 'chain-config', chainIds },
      'ignoring unsupported chain IDs from RPC_URL_<chainId> env vars; add only chains exported by @reown/appkit/networks',
    )
  }
}

function logChainEnvIssues(issues: ChainEnvIssues) {
  if (issues.emptyRpcUrlChainIds.length) {
    logger.error(
      { ctx: 'chain-config', chainIds: issues.emptyRpcUrlChainIds },
      'ignoring empty RPC_URL_<chainId> env vars; set a valid HTTP(S) RPC URL or remove the env var',
    )
  }
  if (issues.malformedRpcUrlChainIds.length) {
    logger.error(
      { ctx: 'chain-config', chainIds: issues.malformedRpcUrlChainIds },
      'ignoring malformed RPC_URL_<chainId> env vars; set a valid HTTP(S) RPC URL',
    )
  }
}

function normalizeChainConfig(config: ChainConfig): ChainConfig {
  const unknownChainIds = [...new Set([
    ...(config.unsupportedChainIds ?? []),
    ...getUnknownChainIds(config.enabledChainIds),
  ])]
  const chainEnvIssues = config.chainEnvIssues ?? {
    emptyRpcUrlChainIds: [],
    malformedRpcUrlChainIds: [],
  }
  logUnknownChainIds(unknownChainIds)
  logChainEnvIssues(chainEnvIssues)

  const enabledChainIds = config.enabledChainIds.filter(id => !unknownChainIds.includes(id))
  const enabledSet = new Set(enabledChainIds)
  const deprecatedChainIds = config.deprecatedChainIds.filter(id => enabledSet.has(id))
  const eVaultFetchChunkChainIds = (config.eVaultFetchChunkChainIds ?? []).filter(id => enabledSet.has(id))

  return { ...config, enabledChainIds, deprecatedChainIds, eVaultFetchChunkChainIds, unsupportedChainIds: unknownChainIds, chainEnvIssues }
}

function scanEnv(): ChainConfig {
  const chainEnvIssues = getChainEnvIssues()
  const unsupportedChainIds = getUnknownChainIds(getConfiguredChainIds())
  logUnknownChainIds(unsupportedChainIds)
  logChainEnvIssues(chainEnvIssues)

  const enabledChainIds = getEnabledChainIds()
  const enabledSet = new Set(enabledChainIds)
  const deprecatedChainIds = parseDeprecatedChains(process.env.DEPRECATED_CHAINS, enabledSet)
  const eVaultFetchChunkChainIds = parseEVaultFetchChunkChainIds(process.env, enabledSet)

  return { enabledChainIds, deprecatedChainIds, eVaultFetchChunkChainIds, unsupportedChainIds, chainEnvIssues }
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
    cached = { enabledChainIds: [], deprecatedChainIds: [], eVaultFetchChunkChainIds: [] }
  }

  return cached!
}
