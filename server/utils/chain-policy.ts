import { loadEulerChains } from '~/server/api/internal/euler-chains.get'
import { readLabelsSource } from './labels-base-url'
import { readChainEnvConfig } from '~/utils/chain-env'
import { readChainRegistry } from '~/utils/chain-status'
import { resolveChainPolicy, getChainReadPolicy, chainReadPolicyKey } from '~/utils/chain-policy'
import { loadV3ChainCatalog, peekV3ChainCatalog, requiresV3ChainCatalog } from './v3-chain-catalog'

/** Public policy only: configured RPCs and other upstream credentials stay server-side. */
export const readServerChainPolicy = (manifest: readonly unknown[] | undefined, catalog = peekV3ChainCatalog()) => {
  const config = resolveChainPolicy(readChainEnvConfig(), readChainRegistry(manifest), process.env.DOPPLER_ENVIRONMENT === 'prd', readLabelsSource(), catalog)
  const unresolved = manifest === undefined || (requiresV3ChainCatalog() && !catalog)
  return { ...config, unresolvedChainIds: unresolved ? [...config.enabledChainIds] : [] }
}

export const loadServerChainPolicy = async () => {
  const [manifest, catalog] = await Promise.all([loadEulerChains(), loadV3ChainCatalog()])
  return readServerChainPolicy(manifest, catalog)
}

export const loadServerChainReadPolicy = async (chainId: number) =>
  getChainReadPolicy(await loadServerChainPolicy(), chainId)

export const loadServerChainPolicyKey = async (chainId: number): Promise<string> =>
  `${chainId}:${chainReadPolicyKey(await loadServerChainReadPolicy(chainId))}`
