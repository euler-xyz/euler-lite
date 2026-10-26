import { createHash } from 'node:crypto'
import {
  createSubgraphCatalogResolver,
  SubgraphUnavailableError as SdkSubgraphUnavailableError,
  type SubgraphResolver,
  type SubgraphQuerySource,
} from '@eulerxyz/euler-v2-sdk'
import { MANIFEST_MAX_STALE_MS } from './euler-interfaces'

export { parseSubgraphCatalog } from '@eulerxyz/euler-v2-sdk'
export type SubgraphUnavailableReason = 'disabled' | 'missing' | 'retired' | 'invalid' | 'unsupported-capability' | 'catalog-unavailable'
export class LiteSubgraphUnavailableError extends Error {
  constructor(public readonly reason: SubgraphUnavailableReason) {
    super(`Subgraph unavailable: ${reason}`)
  }
}
export interface SubgraphSource extends SubgraphQuerySource { identity: string }

/** Lite owns environment priority and privacy; the SDK owns catalog parsing and caching. */
export function createSubgraphResolver({ env = process.env, now = Date.now, fetchCatalog }: {
  env?: Record<string, string | undefined>
  now?: () => number
  fetchCatalog?: (url: string) => Promise<unknown>
} = {}) {
  let selected: { url: string, resolver: SubgraphResolver } | undefined
  return async (chainId: number): Promise<SubgraphSource> => {
    if (env[`SUBGRAPH_DISABLED_${chainId}`]?.trim() === 'true') throw new LiteSubgraphUnavailableError('disabled')
    const endpoint = env[`SUBGRAPH_URL_${chainId}`]?.trim() || env[`NUXT_PUBLIC_SUBGRAPH_URI_${chainId}`]?.trim()
    if (endpoint) return { endpoint, identity: createHash('sha256').update(endpoint).digest('hex') }
    const url = env.SUBGRAPH_CATALOG_URL?.trim()
    if (!url || env.SUBGRAPH_CATALOG_DISABLED?.trim() === 'true') throw new LiteSubgraphUnavailableError('missing')
    if (selected?.url !== url) {
      selected = { url, resolver: createSubgraphCatalogResolver({
        url, now,
        freshMs: 60_000,
        maxAgeMs: MANIFEST_MAX_STALE_MS,
        timeoutMs: 5_000,
        retryMs: 10_000,
        maxResponseBytes: 1_000_000,
        ...(fetchCatalog ? { fetch: async input => Response.json(await fetchCatalog(String(input))) } : {}),
      }) }
    }
    try {
      const [accounts, factories] = await Promise.all([
        selected.resolver.resolve(chainId, 'account-vault-discovery'),
        selected.resolver.resolve(chainId, 'vault-factory-lookup'),
      ])
      if (accounts.endpoint !== factories.endpoint || accounts.deploymentId !== factories.deploymentId) throw new LiteSubgraphUnavailableError('invalid')
      return {
        ...accounts,
        identity: createHash('sha256').update(JSON.stringify([url, accounts.endpoint, accounts.deploymentId])).digest('hex'),
      }
    }
    catch (error) {
      if (error instanceof LiteSubgraphUnavailableError) throw error
      const reason = error instanceof SdkSubgraphUnavailableError && error.reason !== 'source-failed' && error.reason !== 'source-changed'
        ? error.reason
        : 'catalog-unavailable'
      throw new LiteSubgraphUnavailableError(reason)
    }
  }
}

export const resolveSubgraphSource = createSubgraphResolver()
