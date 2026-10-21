import { createCallBundler, type BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { SUBGRAPH_TIMEOUT_MS } from '~/entities/tuning-constants'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isAddress = (value: unknown): value is Address => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value)
const isPosition = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{80}$/i.test(value)

export interface CheckedSubgraphSource { endpoint: string, deploymentId?: string, identity?: string }
type Sources = Record<number, string> | ((chainId: number) => Promise<CheckedSubgraphSource>)

async function querySubgraph(sources: Sources, chainId: number, query: string, ids: string[], selection?: { identity?: string }) {
  const source = typeof sources === 'function' ? await sources(chainId) : { endpoint: sources[chainId] }
  const url = source.endpoint
  if (!url) throw new Error(`Subgraph proxy missing for chain ${chainId}`)
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { ids } }),
    signal: AbortSignal.timeout(SUBGRAPH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Subgraph request failed (${response.status})`)
  const payload: unknown = await response.json()
  if (!object(payload) || (Array.isArray(payload.errors) ? payload.errors.length > 0 : payload.errors != null)
    || !object(payload.data)) throw new Error('Invalid subgraph response')
  const data = payload.data
  if (source.deploymentId && (!object(data._meta) || data._meta.deployment !== source.deploymentId)) {
    throw new Error('Subgraph deployment identity mismatch')
  }
  const selectedIdentity = source.identity ?? response.headers.get('x-subgraph-source') ?? undefined
  const deployment = object(data._meta) && typeof data._meta.deployment === 'string' ? data._meta.deployment : undefined
  const identity = selectedIdentity || deployment ? JSON.stringify([selectedIdentity, deployment]) : undefined
  if (selection) {
    if (selection.identity !== undefined && identity !== selection.identity) throw new Error('Subgraph source changed during lookup')
    selection.identity = identity
  }
  return data
}

type AccountKey = { chainId: number, account: Address }
type FactoryKey = { chainId: number, address: Address }

// A failed chain must not reject another chain's queued discovery request.
function bundleByChain<K extends { chainId: number }, V>(run: (keys: K[]) => Promise<V[]>) {
  const chains = new Map<number, (key: K) => Promise<V>>()
  return (key: K): Promise<V> => {
    let query = chains.get(key.chainId)
    if (!query) {
      query = createCallBundler(run)
      chains.set(key.chainId, query)
    }
    return query(key)
  }
}

/**
 * Checked transport boundary for the published SDK's two subgraph leaf queries.
 * Leaf results are not cached; each read validates the selected source and payload.
 * Valid discovery remains available at the provider's current indexed height.
 * Higher-level SDK queries retain the app's cache/generation policy.
 */
export const withCheckedSubgraphQueries = (buildQuery: BuildQueryFn, sources: Sources): BuildQueryFn => {
  const accounts = bundleByChain(async (keys: AccountKey[]) => {
    const results = new Map<string, Record<string, unknown>>()
    for (const chainId of new Set(keys.map(key => key.chainId))) {
      const ids = [...new Set(keys.filter(key => key.chainId === chainId).map(key => key.account.toLowerCase().slice(0, 40)))]
      const selection: { identity?: string } = {}
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const page = ids.slice(offset, offset + 1000)
        const data = await querySubgraph(sources, chainId, `query AccountVaults($ids: [String!]!) {
          _meta { deployment block { number } }
          trackingActiveAccounts(first: 1000, where: { id_in: $ids }) { id deposits borrows }
        }`, page, selection)
        if (!Array.isArray(data.trackingActiveAccounts)) throw new Error('Invalid subgraph accounts')
        for (const entry of data.trackingActiveAccounts) {
          if (!object(entry) || typeof entry.id !== 'string' || !page.includes(entry.id.toLowerCase())
            || !Array.isArray(entry.deposits) || !entry.deposits.every(isPosition)
            || !Array.isArray(entry.borrows) || !entry.borrows.every(isPosition)) throw new Error('Invalid subgraph account')
          results.set(`${chainId}:${entry.id.toLowerCase()}`, entry)
        }
      }
    }
    return keys.map(key => ({ data: { trackingActiveAccount: results.get(`${key.chainId}:${key.account.toLowerCase().slice(0, 40)}`) ?? null } }))
  })
  const factories = bundleByChain(async (keys: FactoryKey[]) => {
    const results = new Map<string, { id: Address, factory: Address }>()
    for (const chainId of new Set(keys.map(key => key.chainId))) {
      const ids = [...new Set(keys.filter(key => key.chainId === chainId).map(key => key.address.toLowerCase()))]
      const selection: { identity?: string } = {}
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const page = ids.slice(offset, offset + 1000)
        const data = await querySubgraph(sources, chainId, `query VaultFactories($ids: [String!]!) {
          _meta { deployment block { number } }
          vaults(first: 1000, where: { id_in: $ids }) { id factory }
        }`, page, selection)
        if (!Array.isArray(data.vaults)) throw new Error('Invalid subgraph vaults')
        for (const entry of data.vaults) {
          if (!object(entry) || !isAddress(entry.id) || !page.includes(entry.id.toLowerCase()) || !isAddress(entry.factory)) throw new Error('Invalid subgraph vault')
          results.set(`${chainId}:${entry.id.toLowerCase()}`, { id: getAddress(entry.id), factory: getAddress(entry.factory) })
        }
      }
    }
    return keys.map(key => results.get(`${key.chainId}:${key.address.toLowerCase()}`))
  })
  return ((name, fn, target, context) => {
    if (name === 'queryAccountVaults') return accounts
    if (name === 'queryVaultFactories') return factories
    return buildQuery(name, fn, target, context)
  }) as BuildQueryFn
}
