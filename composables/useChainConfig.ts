/**
 * Provides reactive browser chain policy seeded by the HTML response.
 *
 * The server-side composable exposes environment defaults; server data routes
 * resolve registry lifecycle and V3 catalog support through server/utils/chain-policy.ts.
 * On the client, reads from window.__CHAIN_CONFIG__ which is injected
 * by server/plugins/chain-config.ts via the render:html hook. Open tabs refresh
 * the selected chain's policy through a no-store endpoint backed by the
 * server's shared registry and V3 catalog caches. The enabled chain list is seeded on page load.
 *
 * This avoids runtimeConfig (which is frozen in production) and works
 * with environment variables injected at runtime by Doppler.
 */
import { readChainEnvConfig, type ChainEnvIssues } from '~/utils/chain-env'
import { getUnknownChainIds } from '~/entities/chainRegistry'
import { logger } from '~/utils/logger'
import { getChainReadPolicy, chainReadPolicyKey, type ChainReadPolicy, type ChainPolicyResponse } from '~/utils/chain-policy'
import { advanceSdkQueryGeneration } from '~/utils/sdk-query-cache'
import { SDK_QUERY_POLICY } from '~/utils/sdk-query-policy'
import type { EulerSDKQueryName } from '@eulerxyz/euler-v2-sdk'

interface ChainConfig {
  enabledChainIds: number[]
  deprecatedChainIds: number[]
  onchainSdkChainIds: number[]
  metadataOnlyChainIds?: number[]
  unresolvedChainIds?: number[]
  policyRevision?: number
  eVaultFetchChunkChainIds: number[]
  unsupportedChainIds?: number[]
  chainEnvIssues?: ChainEnvIssues
  explorerUrls?: Record<number, string>
}

let cached: ChainConfig | null = null
const policyGenerations = shallowReactive(new Map<number, number>())
const pendingPolicyReads = new Map<number, Promise<void>>()
const policyListeners = new Set<(chainId: number) => void>()

export const getChainPolicyGeneration = (chainId: number): number => policyGenerations.get(chainId) ?? 0

export const isChainReadPolicyReady = (chainId: number): boolean =>
  !useChainConfig().unresolvedChainIds?.includes(chainId)

/** Cold reads need an authoritative policy; an existing policy survives refresh failures. */
export const ensureChainReadPolicy = async (chainId: number): Promise<void> => {
  if (isChainReadPolicyReady(chainId)) return
  await refreshChainReadPolicy(chainId)
  if (!isChainReadPolicyReady(chainId)) throw new Error('Chain policy unavailable')
}

export const subscribeToChainPolicyChanges = (listener: (chainId: number) => void) => {
  policyListeners.add(listener)
  return () => policyListeners.delete(listener)
}

/** Routing remains refreshable when the labels upstream is unavailable. */
export const refreshChainReadPolicy = (chainId: number): Promise<void> => {
  const pending = pendingPolicyReads.get(chainId)
  if (pending) return pending
  const generation = getChainPolicyGeneration(chainId)
  const task = $fetch<ChainPolicyResponse>('/api/internal/chain-policy', {
    query: { chainId },
    cache: 'no-store',
    timeout: 10_000,
  }).then((response) => {
    if (response.chainId !== chainId) throw new Error('Chain policy response does not match the requested chain')
    if (getChainPolicyGeneration(chainId) === generation) applyChainReadPolicy(chainId, response.policy)
  }).finally(() => {
    if (pendingPolicyReads.get(chainId) === task) pendingPolicyReads.delete(chainId)
  })
  pendingPolicyReads.set(chainId, task)
  return task
}

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
  const onchainSdkChainIds = (config.onchainSdkChainIds ?? []).filter(id => enabledSet.has(id))
  const eVaultFetchChunkChainIds = (config.eVaultFetchChunkChainIds ?? []).filter(id => enabledSet.has(id))

  const metadataOnlyChainIds = (config.metadataOnlyChainIds ?? []).filter(id => enabledSet.has(id))
  const unresolvedChainIds = (config.unresolvedChainIds ?? []).filter(id => enabledSet.has(id))
  return { ...config, enabledChainIds, deprecatedChainIds, onchainSdkChainIds, metadataOnlyChainIds, unresolvedChainIds, policyRevision: 0, eVaultFetchChunkChainIds, unsupportedChainIds: unknownChainIds, chainEnvIssues }
}

/** Apply an authoritative policy read and invalidate derived in-flight state. */
export const applyChainReadPolicy = (chainId: number, policy: ChainReadPolicy): boolean => {
  const config = useChainConfig()
  if (!config.enabledChainIds.includes(chainId)) return false
  if (isChainReadPolicyReady(chainId) && chainReadPolicyKey(getChainReadPolicy(config, chainId)) === chainReadPolicyKey(policy)) return false
  const update = (ids: number[], included: boolean) => {
    const next = ids.filter(id => id !== chainId)
    if (included) next.push(chainId)
    ids.splice(0, ids.length, ...next.sort((a, b) => a - b))
  }
  update(config.deprecatedChainIds, policy.deprecated)
  update(config.onchainSdkChainIds, policy.onchain)
  update(config.metadataOnlyChainIds ??= [], policy.metadataOnly)
  update(config.unresolvedChainIds ??= [], false)
  policyGenerations.set(chainId, getChainPolicyGeneration(chainId) + 1)
  config.policyRevision = (config.policyRevision ?? 0) + 1
  for (const listener of policyListeners) listener(chainId)
  // Pending reads finish in their original generation; new SDKs cannot join them.
  void advanceSdkQueryGeneration(Object.keys(SDK_QUERY_POLICY) as EulerSDKQueryName[])
  return true
}

export const useChainConfig = (): ChainConfig => {
  if (cached) return cached

  if (import.meta.server) {
    cached = normalizeChainConfig(readChainEnvConfig())
  }
  /* eslint-disable @typescript-eslint/no-explicit-any -- server-injected window global */
  else if (typeof window !== 'undefined' && (window as any).__CHAIN_CONFIG__) {
    cached = reactive(normalizeChainConfig((window as any).__CHAIN_CONFIG__))
  /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  else {
    cached = reactive({ enabledChainIds: [], deprecatedChainIds: [], onchainSdkChainIds: [], metadataOnlyChainIds: [], unresolvedChainIds: [], policyRevision: 0, eVaultFetchChunkChainIds: [] })
  }

  return cached!
}
