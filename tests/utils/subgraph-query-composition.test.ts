import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountVaultsSubgraphAdapter, VaultTypeSubgraphAdapter, createQueryCacheBuildQuery, type BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { SUBGRAPH_TIMEOUT_MS } from '~/entities/tuning-constants'
import { withCheckedSubgraphQueries } from '~/utils/subgraph-queries'
import { clearSdkQueryFailureCacheForTest, clearSdkQueryGenerationsForTest, invalidateSdkQueries, sdkBuildQuery, sdkFreshBuildQuery, sdkQueryClient } from '~/utils/sdk-query-cache'

const account = '0x0000000000000000000000000000000000000001' as const
const proxyUrl = '/api/internal/proxy/subgraph/1'
const proxyIdentity = 'opaque-proxy-source'
const nativeSource = { endpoint: 'https://native-catalog.example/query', deploymentId: 'native' }

// Logging or metrics wrappers return a new function without copying SDK metadata.
const withOuterWrapper = (inner: BuildQueryFn): BuildQueryFn => (name, fn, target, context) => {
  const query = inner(name, fn, target, context)
  return ((...args: Parameters<typeof fn>) => query(...args)) as typeof fn
}

const responseData = (block: number) => ({ data: {
  _meta: { deployment: 'selected', block: { number: block } },
  trackingActiveAccounts: [{ id: account.slice(0, 40), deposits: [`${account}${account.slice(2)}`], borrows: [] }],
  vaults: [{ id: account, factory: account }],
} })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sdkQueryClient.clear()
  clearSdkQueryFailureCacheForTest()
  clearSdkQueryGenerationsForTest()
})

describe('Lite subgraph policy under outer SDK query wrappers', () => {
  it.each([
    ['browser accounts', sdkBuildQuery, 'accounts', 300_000, false],
    ['browser factories', sdkBuildQuery, 'factories', 300_000, false],
    ['form accounts', sdkFreshBuildQuery, 'accounts', 60_000, false],
    ['form factories', sdkFreshBuildQuery, 'factories', 300_000, false],
    ['server accounts', createQueryCacheBuildQuery(), 'accounts', 5_000, true],
    ['server factories', createQueryCacheBuildQuery(), 'factories', 5_000, true],
  ] as const)('preserves the %s source, transport and cache', async (_label, cache, kind, ttl, server) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const startedAt = Date.now()
    const endpoint = server ? 'https://private-fork.example/query?key=server-only' : proxyUrl
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    let request = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(endpoint)
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(JSON.parse(init.body as string).query).toContain('_meta')
      // Discovery stays usable if the next valid response is indexed further behind.
      return Response.json(responseData(100 - request++), { headers: { 'x-subgraph-source': proxyIdentity } })
    })
    vi.stubGlobal('fetch', fetch)
    const resolve = vi.fn(async () => nativeSource)
    const checked = withOuterWrapper(withCheckedSubgraphQueries(cache, server
      ? async () => ({ endpoint, deploymentId: 'selected', identity: 'server-selection' })
      : { 1: endpoint }))
    const config = { subgraphURLs: {}, resolver: { resolve } }
    const accounts = new AccountVaultsSubgraphAdapter(config, checked)
    const factories = new VaultTypeSubgraphAdapter(config, checked)
    const read = () => kind === 'accounts'
      ? accounts.fetchAccountVaults(1, account)
      : factories.fetchVaultFactories(1, [account])
    const readWithSource = () => kind === 'accounts'
      ? accounts.fetchAccountVaultsWithSource(1, account)
      : factories.fetchVaultFactoriesWithSource(1, [account])
    const expected = kind === 'accounts'
      ? { [account]: { deposits: [account], borrows: [] } }
      : [{ id: account, factory: account }]

    await expect(read()).resolves.toEqual(expected)
    await expect(readWithSource()).resolves.toEqual({ value: expected })
    vi.setSystemTime(startedAt + ttl - 1)
    await expect(read()).resolves.toEqual(expected)
    expect(fetch).toHaveBeenCalledOnce()
    vi.setSystemTime(startedAt + ttl)
    await expect(read()).resolves.toEqual(expected)
    expect(fetch).toHaveBeenCalledTimes(2)
    if (!server) {
      await invalidateSdkQueries(['queryAccountVaults', 'queryVaultFactories'])
      await expect(read()).resolves.toEqual(expected)
      expect(fetch).toHaveBeenCalledTimes(3)
    }
    expect(timeout).toHaveBeenCalledWith(SUBGRAPH_TIMEOUT_MS)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['accounts', 'factories'] as const)('rejects changed proxy identity across %s pages with a configured source identity', async (kind) => {
    let page = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(proxyUrl)
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      const { variables: { ids } } = JSON.parse(init.body as string) as { variables: { ids: string[] } }
      page++
      return Response.json({ data: {
        _meta: { deployment: 'selected', block: { number: 100 } },
        trackingActiveAccounts: ids.map(id => ({ id, deposits: [], borrows: [] })),
        vaults: ids.map(id => ({ id, factory: account })),
      } }, { headers: { 'x-subgraph-source': page === 1 ? proxyIdentity : 'replacement-proxy-source' } })
    })
    vi.stubGlobal('fetch', fetch)
    const resolve = vi.fn(async () => nativeSource)
    const checked = withOuterWrapper(withCheckedSubgraphQueries(sdkBuildQuery,
      async () => ({ endpoint: proxyUrl, deploymentId: 'selected', identity: 'server-selection' })))
    const config = { subgraphURLs: {}, resolver: { resolve } }
    const accounts = new AccountVaultsSubgraphAdapter(config, checked)
    const factories = new VaultTypeSubgraphAdapter(config, checked)
    const addresses = Array.from({ length: 1001 }, (_, i) => `0x${(i + 1).toString(16).padStart(38, '0')}00` as Address)
    const read = kind === 'accounts'
      ? Promise.all(addresses.map(address => accounts.fetchAccountVaults(1, address)))
      : factories.fetchVaultFactories(1, addresses)
    await expect(read).rejects.toMatchObject({ reason: 'source-changed' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['accounts', 'factories'] as const)('keeps %s source failures authoritative instead of falling back to the SDK catalog', async (kind) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const resolve = vi.fn(async () => nativeSource)
    const checked = withOuterWrapper(withCheckedSubgraphQueries(sdkBuildQuery, async () => {
      throw new Error('Subgraph unavailable: retired')
    }))
    const config = { subgraphURLs: {}, resolver: { resolve } }
    const accounts = new AccountVaultsSubgraphAdapter(config, checked)
    const factories = new VaultTypeSubgraphAdapter(config, checked)
    const read = kind === 'accounts'
      ? accounts.fetchAccountVaultsWithSource(1, account)
      : factories.fetchVaultFactoriesWithSource(1, [account])
    await expect(read).rejects.toThrow('Subgraph unavailable: retired')
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
