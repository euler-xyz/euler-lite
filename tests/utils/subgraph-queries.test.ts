import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultTypeSubgraphAdapter, type BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { AccountVaultsSubgraphAdapter } from '../../node_modules/@eulerxyz/euler-v2-sdk/dist/src/services/accountService/adapters/accountOnchainAdapter/accountVaultsSubgraphAdapter.js'
import { withCheckedSubgraphQueries, requireSubgraphBlock } from '~/utils/subgraph-queries'
import { advanceSdkQueryGeneration, sdkBuildQuery, sdkQueryClient } from '~/utils/sdk-query-cache'
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
})

describe('checked published-SDK subgraph queries', () => {
  it('rejects the 503 JSON body that SDK 4.2.0 turns into empty discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ statusCode: 503, message: 'retired' }), { status: 503 })))
    await expect(makeQuery('/fixture/error')({ chainId: 1, account: address })).rejects.toThrow('503')
  })
  it('rejects GraphQL errors and missing data but accepts a successful empty account list', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'indexing error' }], data: { trackingActiveAccounts: [] } }))
      .mockResolvedValueOnce(Response.json({ data: {} }))
      .mockResolvedValueOnce(Response.json({ data: { trackingActiveAccounts: [] } }))
    vi.stubGlobal('fetch', fetch)
    const query = makeQuery('/fixture/empty')
    await expect(query({ chainId: 1, account: address })).rejects.toThrow('Invalid subgraph response')
    await expect(query({ chainId: 1, account: address })).rejects.toThrow('Invalid subgraph accounts')
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
  it('rechecks actual data after source switch and waits for the replacement deployment to catch up', async () => {
    vi.useFakeTimers()
    const url = '/fixture/source-switch'
    requireSubgraphBlock(url, 100n)
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(reply(90, 'B')))
      .mockResolvedValueOnce(Response.json(reply(100, 'B')))
    vi.stubGlobal('fetch', fetch)
    const pending = makeQuery(url)({ chainId: 1, account: address })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(pending).resolves.toMatchObject({ data: { trackingActiveAccount: { id: prefix } } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('checks an already in-flight read against a newly confirmed block', async () => {
    let resolveResponse!: (value: Response) => void
    const fetch = vi.fn(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve
    }))
    vi.stubGlobal('fetch', fetch)
    const pending = makeQuery('/fixture/inflight')({ chainId: 1, account: address })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    requireSubgraphBlock('/fixture/inflight', 100n)
    resolveResponse(Response.json({ data: { trackingActiveAccounts: [] } }))
    await expect(pending).rejects.toThrow('Invalid subgraph block')
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
    await expect(adapter.fetchVaultFactories(1, addresses)).rejects.toThrow('Subgraph source changed during lookup')
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
    expect(results.every(result => result.status === 'rejected' && result.reason.message === 'Subgraph source changed during lookup')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
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
    expect(results.slice(0, -1).every(result => result.status === 'rejected' && result.reason.message === 'Invalid subgraph account')).toBe(true)
    expect(results.at(-1)).toEqual({ status: 'fulfilled', value: { [accounts[0]]: { deposits: [address], borrows: [] } } })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('checks the confirmed block watermark on every page before returning accounts', async () => {
    vi.useFakeTimers()
    const url = '/fixture/account-pages/watermark'
    requireSubgraphBlock(url, 100n)
    let request = 0
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { variables: { ids } } = readAccountRequest(init)
      request++
      return Response.json(accountPage(ids, request === 2 ? 99 : 100))
    })
    vi.stubGlobal('fetch', fetch)
    const adapter = accountAdapter({ 1: url })
    const pending = Promise.all(owners(1001).map(account => adapter.fetchAccountVaults(1, account)))
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(pending).resolves.toHaveLength(1001)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(readAccountRequest(fetch.mock.calls[1][1]).variables.ids).toEqual(readAccountRequest(fetch.mock.calls[2][1]).variables.ids)
  })
})
