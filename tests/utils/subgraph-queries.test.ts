import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultTypeSubgraphAdapter, type BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
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
