import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountVaultsSubgraphAdapter, VaultTypeSubgraphAdapter, createQueryCacheBuildQuery, type BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { withCheckedSubgraphQueries } from '~/utils/subgraph-queries'
import { advanceSdkQueryGeneration, clearSdkQueryFailureCacheForTest, clearSdkQueryGenerationsForTest, invalidateSdkQueries, sdkBuildQuery, sdkFreshBuildQuery, sdkQueryClient } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'

const address = '0x0000000000000000000000000000000000000001' as const
const prefix = address.slice(0, 40)
const reply = (block = 100, deployment = 'A') => ({ data: { _meta: { deployment, block: { number: block } }, trackingActiveAccounts: [{ id: prefix, deposits: [], borrows: [] }] } })
const makeQuery = (url: string, buildQuery: BuildQueryFn = sdkBuildQuery) => withCheckedSubgraphQueries(buildQuery, { 1: url })('queryAccountVaults', async () => {
  throw new Error('unchecked SDK transport used')
}, {}) as (key: { chainId: number, account: typeof address }) => Promise<unknown>

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sdkQueryClient.clear()
  clearSdkQueryFailureCacheForTest()
  clearSdkQueryGenerationsForTest()
})

describe('checked published-SDK subgraph queries', () => {
  it('rejects an HTTP 503 JSON body without reporting empty discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ statusCode: 503, message: 'retired' }), { status: 503 })))
    await expect(makeQuery('/fixture/error')({ chainId: 1, account: address })).rejects.toThrow('503')
  })
  it('rejects GraphQL errors and missing data but accepts a successful empty account list', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'indexing error' }], data: { trackingActiveAccounts: [] } }))
      .mockResolvedValueOnce(Response.json({ data: {} }))
      .mockResolvedValueOnce(Response.json({ data: { trackingActiveAccounts: [] } }))
    vi.stubGlobal('fetch', fetch)
    const query = makeQuery('/fixture/empty')
    await expect(query({ chainId: 1, account: address })).rejects.toThrow('Account vaults subgraph returned GraphQL errors.')
    vi.setSystemTime(start + 5_000)
    await expect(query({ chainId: 1, account: address })).rejects.toThrow('Account vaults subgraph returned malformed account data.')
    vi.setSystemTime(start + 10_000)
    await expect(query({ chainId: 1, account: address })).resolves.toEqual({ data: { trackingActiveAccount: null } })
  })
  it('reaches checked reads after post-tx generation invalidation of higher-level cached queries', async () => {
    const fetch = vi.fn(async () => Response.json(reply()))
    vi.stubGlobal('fetch', fetch)
    const leaf = makeQuery('/fixture/generation')
    const parent = sdkBuildQuery('queryVaultAccountInfo', async () => leaf({ chainId: 1, account: address }), {})
    await parent()
    await parent()
    expect(fetch).toHaveBeenCalledTimes(1)
    await advanceSdkQueryGeneration([...INVALIDATE_AFTER_TX])
    await parent()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('reads a replacement deployment even when it has indexed an older block', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(reply(100, 'A')))
      .mockResolvedValueOnce(Response.json(reply(90, 'B')))
    vi.stubGlobal('fetch', fetch)
    let deploymentId = 'A'
    const query = withCheckedSubgraphQueries(sdkBuildQuery, async () => ({ endpoint: '/fixture/source-switch', deploymentId }))('queryAccountVaults', async (_key: { chainId: number, account: typeof address }) => null, {})
    await expect(query({ chainId: 1, account: address })).resolves.toMatchObject({ data: { trackingActiveAccount: { id: prefix } } })
    deploymentId = 'B'
    await expect(query({ chainId: 1, account: address })).resolves.toMatchObject({ data: { trackingActiveAccount: { id: prefix } } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('rejects deployment mismatches even when the response is otherwise valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(reply(90, 'wrong-deployment'))))
    const query = withCheckedSubgraphQueries(sdkBuildQuery, async () => ({
      endpoint: '/fixture/pinned', deploymentId: 'selected-deployment',
    }))('queryAccountVaults', async (_key: { chainId: number, account: typeof address }) => null, {})
    await expect(query({ chainId: 1, account: address })).rejects.toMatchObject({ reason: 'source-changed' })
  })
  it('isolates a failed chain while coalescing same-chain callers', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/2')
      ? new Response('{}', { status: 503 })
      : Response.json(reply()))
    vi.stubGlobal('fetch', fetch)
    const query = withCheckedSubgraphQueries(sdkBuildQuery, { 1: '/fixture/1', 2: '/fixture/2' })('queryAccountVaults', async (_key: { chainId: number, account: typeof address }) => null, {})
    const results = await Promise.allSettled([
      query({ chainId: 1, account: address }), query({ chainId: 2, account: address }), query({ chainId: 1, account: address }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a multi-page factory lookup when a mutable endpoint changes deployment identity', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { _meta: { deployment: 'old' }, vaults: [] } }, { headers: { 'x-subgraph-source': 'A' } }))
      .mockResolvedValueOnce(Response.json({ data: { _meta: { deployment: 'new' }, vaults: [] } }, { headers: { 'x-subgraph-source': 'A' } }))
    vi.stubGlobal('fetch', fetch)
    const adapter = new VaultTypeSubgraphAdapter({ subgraphURLs: { 1: '/fixture/pages' } }, withCheckedSubgraphQueries(sdkBuildQuery, { 1: '/fixture/pages' }))
    const addresses = Array.from({ length: 1001 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}` as `0x${string}`)
    await expect(adapter.fetchVaultFactories(1, addresses)).rejects.toMatchObject({ reason: 'source-changed' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses published VaultTypeSubgraphAdapter query arguments and returns checksummed factories', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { vaults: [{ id: address, factory: address }] } })))
    const adapter = new VaultTypeSubgraphAdapter({ subgraphURLs: { 1: '/fixture/factories' } }, withCheckedSubgraphQueries(sdkBuildQuery, { 1: '/fixture/factories' }))
    await expect(adapter.fetchVaultFactories(1, [address])).resolves.toEqual([{ id: address, factory: address }])
  })
})

const owners = (count: number) => Array.from({ length: count }, (_, i) => `0x${(i + 1).toString(16).padStart(38, '0')}00` as Address)
const accountPage = (ids: string[], block = 100, deployment = 'A') => ({
  data: {
    _meta: { deployment, block: { number: block } },
    trackingActiveAccounts: ids.map(id => ({ id, deposits: [`${id}00${address.slice(2)}`], borrows: [] })),
  },
})
const readAccountRequest = (init: RequestInit) => JSON.parse(init.body as string) as { query: string, variables: { ids: string[] } }
const accountAdapter = (sources: Parameters<typeof withCheckedSubgraphQueries>[1] = { 1: '/fixture/account-pages' }) => new AccountVaultsSubgraphAdapter(
  { subgraphURLs: { 1: '/fixture/account-pages', 2: '/fixture/account-pages/2' } },
  withCheckedSubgraphQueries(sdkBuildQuery, sources),
)

describe('checked account pagination through the published SDK adapter', () => {
  it.each([101, 1001, 2001])('discovers all %i owners with explicit bounded page sizes', async (count) => {
    const requests: string[][] = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables: { ids } } = readAccountRequest(init)
      requests.push(ids)
      // Match the Graph's default first: 100 when a caller omits the limit.
      const first = Number(query.match(/trackingActiveAccounts\(first: (\d+)/)?.[1] ?? 100)
      expect(first).toBe(1000)
      expect(ids.length).toBeLessThanOrEqual(1000)
      return Response.json(accountPage(ids.slice(0, first)))
    })
    vi.stubGlobal('fetch', fetch)
    const adapter = accountAdapter()
    const accounts = owners(count)
    const results = await Promise.all(accounts.map(account => adapter.fetchAccountVaults(1, account)))
    expect(requests.flat()).toEqual(accounts.map(account => account.slice(0, 40)))
    expect(requests.map(page => page.length)).toEqual(count === 101 ? [101] : count === 1001 ? [1000, 1] : [1000, 1000, 1])
    expect(results).toEqual(accounts.map(account => ({ [getAddress(account)]: { deposits: [address], borrows: [] } })))
  })

  it('deduplicates mixed-case owner prefixes and accepts genuinely missing owners', async () => {
    const owner = '0xabcdefabcdefabcdefabcdefabcdefabcdefab00' as Address
    const sameOwner = '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFAB01' as Address
    const absent = owners(1)[0]
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { variables: { ids } } = readAccountRequest(init)
      expect(ids).toEqual([owner.slice(0, 40), absent.slice(0, 40)])
      return Response.json(accountPage([`0x${owner.slice(2, 40).toUpperCase()}`]))
    })
    vi.stubGlobal('fetch', fetch)
    const adapter = accountAdapter()
    const results = await Promise.all([owner, sameOwner, absent].map(account => adapter.fetchAccountVaults(1, account)))
    expect(results).toEqual([
      { [getAddress(owner)]: { deposits: [address], borrows: [] } },
      { [getAddress(owner)]: { deposits: [address], borrows: [] } },
      {},
    ])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['header', 'deployment', 'resolver'] as const)('rejects all pages when the %s identity changes', async (kind) => {
    let page = 0
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { variables: { ids } } = readAccountRequest(init)
      page++
      return Response.json(accountPage(ids, 100, kind === 'deployment' && page === 2 ? 'B' : 'A'), {
        headers: { 'x-subgraph-source': kind === 'header' && page === 2 ? 'B' : 'A' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    const adapter = accountAdapter(kind === 'resolver'
      ? async () => ({ endpoint: '/fixture/account-pages', identity: page === 0 ? 'A' : 'B', deploymentId: 'A' })
      : undefined)
    const results = await Promise.allSettled(owners(1001).map(account => adapter.fetchAccountVaults(1, account)))
    expect(results.every(result => result.status === 'rejected' && result.reason.reason === 'source-changed')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(kind === 'resolver' ? 1 : 2)
  })

  it('validates account membership against each page and isolates a failed chain', async () => {
    const accounts = owners(1001)
    let page = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const { variables: { ids } } = readAccountRequest(init)
      if (url.endsWith('/2')) return Response.json(accountPage(ids))
      page++
      return Response.json(accountPage(page === 2 ? [accounts[0].slice(0, 40)] : ids))
    })
    vi.stubGlobal('fetch', fetch)
    const adapter = accountAdapter({ 1: '/fixture/account-pages', 2: '/fixture/account-pages/2' })
    const results = await Promise.allSettled([
      ...accounts.map(account => adapter.fetchAccountVaults(1, account)),
      adapter.fetchAccountVaults(2, accounts[0]),
    ])
    expect(results.slice(0, -1).every(result => result.status === 'rejected' && result.reason.message === 'Account vaults subgraph returned malformed account data.')).toBe(true)
    expect(results.at(-1)).toEqual({ status: 'fulfilled', value: { [accounts[0]]: { deposits: [address], borrows: [] } } })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('accepts different indexed heights across pages from the same deployment', async () => {
    let request = 0
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { variables: { ids } } = readAccountRequest(init)
      request++
      return Response.json(accountPage(ids, request === 2 ? 99 : 100))
    })
    vi.stubGlobal('fetch', fetch)
    const adapter = accountAdapter()
    const accounts = owners(1001)
    const results = await Promise.all(accounts.map(account => adapter.fetchAccountVaults(1, account)))
    expect(results).toEqual(accounts.map(account => ({ [getAddress(account)]: { deposits: [address], borrows: [] } })))
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('checked subgraph cache policy', () => {
  it.each([
    ['browser accounts', sdkBuildQuery, 'queryAccountVaults', 300_000],
    ['browser factories', sdkBuildQuery, 'queryVaultFactories', 300_000],
    ['form accounts', sdkFreshBuildQuery, 'queryAccountVaults', 60_000],
    ['form factories', sdkFreshBuildQuery, 'queryVaultFactories', 300_000],
    ['server accounts', createQueryCacheBuildQuery(), 'queryAccountVaults', 5_000],
    ['server factories', createQueryCacheBuildQuery(), 'queryVaultFactories', 5_000],
  ] as const)('uses the actual %s cache through the published adapter', async (_label, buildQuery, name, ttl) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const fetch = vi.fn(async () => Response.json({ data: { ...reply().data, vaults: [{ id: address, factory: address }] } }))
    vi.stubGlobal('fetch', fetch)
    const config = { subgraphURLs: { 1: '/fixture/cache' } }
    const checked = withCheckedSubgraphQueries(buildQuery, config.subgraphURLs)
    const accounts = new AccountVaultsSubgraphAdapter(config, checked)
    const factories = new VaultTypeSubgraphAdapter(config, checked)
    const read = () => name === 'queryAccountVaults' ? accounts.fetchAccountVaults(1, address) : factories.fetchVaultFactories(1, [address])
    const first = await read()
    await expect(read()).resolves.toEqual(first)
    vi.setSystemTime(start + ttl - 1)
    await expect(read()).resolves.toEqual(first)
    expect(fetch).toHaveBeenCalledOnce()
    vi.setSystemTime(start + ttl)
    await expect(read()).resolves.toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('applies the shorter form window to the shared browsing cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const fetch = vi.fn(async () => Response.json(reply()))
    vi.stubGlobal('fetch', fetch)
    const browsing = makeQuery('/fixture/shared-form')
    const form = makeQuery('/fixture/shared-form', sdkFreshBuildQuery)
    const key = { chainId: 1, account: address }
    await browsing(key)
    vi.setSystemTime(start + 59_999)
    await form(key)
    expect(fetch).toHaveBeenCalledOnce()
    vi.setSystemTime(start + 60_000)
    await form(key)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('isolates different fork endpoints even when SDK cache keys omit the source', async () => {
    const fetch = vi.fn(async (_url: string) => Response.json(reply()))
    vi.stubGlobal('fetch', fetch)
    const key = { chainId: 1, account: address }
    const context = { getCacheKey: vi.fn((_args: unknown[]) => 'same-sdk-key') }
    const target = {}
    const first = withCheckedSubgraphQueries(sdkBuildQuery, { 1: '/fork/A' })('queryAccountVaults', async (_key: typeof key) => null, target, context)
    const second = withCheckedSubgraphQueries(sdkBuildQuery, { 1: '/fork/B' })('queryAccountVaults', async (_key: typeof key) => null, target, context)
    await first(key)
    await second(key)
    await first(key)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/fork/A', '/fork/B'])
    expect(context.getCacheKey).toHaveBeenLastCalledWith([key])
  })

  it('checks server retirement before a cached result and recovers without a fallback', async () => {
    let retired = false
    const fetch = vi.fn(async () => Response.json(reply()))
    vi.stubGlobal('fetch', fetch)
    const resolve = vi.fn(async () => {
      if (retired) throw new Error('Subgraph unavailable: retired')
      return { endpoint: '/fixture/retirement', deploymentId: 'A' }
    })
    const query = withCheckedSubgraphQueries(createQueryCacheBuildQuery(), resolve)('queryAccountVaults', async (_key: { chainId: number, account: typeof address }) => null, {})
    const key = { chainId: 1, account: address }
    await query(key)
    await query(key)
    expect(fetch).toHaveBeenCalledOnce()
    retired = true
    await expect(query(key)).rejects.toThrow('retired')
    expect(fetch).toHaveBeenCalledOnce()
    retired = false
    await expect(query(key)).resolves.toMatchObject({ data: { trackingActiveAccount: { id: prefix } } })
  })

  it('checks browser retirement on expiry instead of indefinitely serving cached discovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(reply()))
      .mockImplementation(async () => Response.json({ statusMessage: 'retired' }, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const query = makeQuery('/fixture/browser-retirement')
    const key = { chainId: 1, account: address }
    await query(key)
    vi.setSystemTime(start + 299_999)
    await query(key)
    expect(fetch).toHaveBeenCalledOnce()
    vi.setSystemTime(start + 300_000)
    await expect(query(key)).rejects.toThrow('503')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('invalidates leaf caches after a transaction', async () => {
    const fetch = vi.fn(async () => Response.json({ data: { ...reply().data, vaults: [{ id: address, factory: address }] } }))
    vi.stubGlobal('fetch', fetch)
    const config = { subgraphURLs: { 1: '/fixture/invalidate' } }
    const checked = withCheckedSubgraphQueries(sdkBuildQuery, config.subgraphURLs)
    const accounts = new AccountVaultsSubgraphAdapter(config, checked)
    const factories = new VaultTypeSubgraphAdapter(config, checked)
    const read = () => Promise.all([accounts.fetchAccountVaults(1, address), factories.fetchVaultFactories(1, [address])])
    await read()
    await read()
    expect(fetch).toHaveBeenCalledTimes(2)
    await invalidateSdkQueries([...INVALIDATE_AFTER_TX])
    await read()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('starts a separate checked fetch after generation advancement during an in-flight read', async () => {
    let finishFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => {
      finishFirst = resolve
    })
    const fetch = vi.fn().mockReturnValueOnce(firstResponse).mockImplementation(async () => Response.json(reply(90)))
    vi.stubGlobal('fetch', fetch)
    const query = makeQuery('/fixture/inflight-generation')
    const key = { chainId: 1, account: address }
    const first = query(key)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await advanceSdkQueryGeneration(['queryAccountVaults'])
    await expect(query(key)).resolves.toMatchObject({ data: { trackingActiveAccount: { id: prefix } } })
    finishFirst(Response.json({ data: { ...reply().data, trackingActiveAccounts: [] } }))
    await expect(first).resolves.toEqual({ data: { trackingActiveAccount: null } })
    await expect(query(key)).resolves.toMatchObject({ data: { trackingActiveAccount: { id: prefix } } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('preserves null-key opt-out for successes and errors with the original arguments', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockImplementation(async () => Response.json(reply()))
    vi.stubGlobal('fetch', fetch)
    const key = { chainId: 1, account: address }
    const context = { getCacheKey: vi.fn((_args: unknown[]) => null) }
    const query = withCheckedSubgraphQueries(sdkBuildQuery, { 1: '/fixture/no-cache' })('queryAccountVaults', async (_key: typeof key) => null, {}, context)
    await expect(query(key)).rejects.toThrow('503')
    await query(key)
    await query(key)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(context.getCacheKey).toHaveBeenCalledTimes(3)
    expect(context.getCacheKey.mock.calls.every(([args]) => args.length === 1 && args[0] === key)).toBe(true)
  })
})
