import { afterEach, expect, it, vi } from 'vitest'
import { AccountVaultsSubgraphAdapter, VaultTypeSubgraphAdapter } from '@eulerxyz/euler-v2-sdk'
import { refreshPortfolioAfterReviewedSubmission } from '~/features/reviewed-execution/review/post-tx-refresh'
import { withCheckedSubgraphQueries } from '~/utils/subgraph-queries'
import { sdkBuildQuery, sdkQueryClient } from '~/utils/sdk-query-cache'

const mocks = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('axios', () => ({ default: { post: mocks.post } }))
vi.mock('~/composables/useEulerSdk', () => ({
  buildSubgraphProxyApiPath: (chainId: number) => `/fixture/refresh/${chainId}`,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sdkQueryClient.clear()
})

it('advances query generations after catch-up while accepting valid older in-flight discovery', async () => {
  let finishPoll!: (value: unknown) => void
  mocks.post.mockImplementation(() => new Promise((resolve) => {
    finishPoll = resolve
  }))
  let finishOldRead!: (value: Response) => void
  const account = '0x0000000000000000000000000000000000000001' as const
  const data = (number: number, deployment: string) => ({ data: {
    _meta: { deployment, block: { number } },
    trackingActiveAccounts: [{ id: account.slice(0, 40), deposits: [], borrows: [] }],
  } })
  const fetch = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishOldRead = resolve
    }))
    .mockImplementation(async () => Response.json(data(123, 'replacement')))
  vi.stubGlobal('fetch', fetch)
  const query = withCheckedSubgraphQueries(sdkBuildQuery, { 1: '/fixture/refresh/1' })('queryAccountVaults', async (_key: { chainId: number, account: typeof account }) => null, {})
  const reads: Promise<unknown>[] = []
  const refresh = refreshPortfolioAfterReviewedSubmission({ chainId: 1, confirmedBlockNumber: 123n, triggerPortfolioRefresh: () => {
    reads.push(query({ chainId: 1, account }))
  } })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  finishPoll({ data: { data: { _meta: { deployment: 'original', block: { number: 123 } } } } })
  await refresh
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await expect(reads[1]).resolves.toMatchObject({ data: { trackingActiveAccount: { id: account.slice(0, 40) } } })
  finishOldRead(Response.json(data(122, 'original')))
  await expect(reads[0]).resolves.toMatchObject({ data: { trackingActiveAccount: { id: account.slice(0, 40) } } })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each(['direct', 'catalog'] as const)('keeps %s discovery usable during indexer lag and after catch-up times out', async (source) => {
  vi.useFakeTimers()
  const chainId = source === 'direct' ? 2 : 3
  const url = `/fixture/refresh/${chainId}`
  const account = '0x0000000000000000000000000000000000000001' as const
  const vault = '0x0000000000000000000000000000000000000002' as const
  const factory = '0x0000000000000000000000000000000000000003' as const
  const laggingData = {
    _meta: { deployment: 'selected', block: { number: 122 } },
    trackingActiveAccounts: [{ id: account.slice(0, 40), deposits: [`${account}${vault.slice(2)}`], borrows: [] }],
    vaults: [{ id: vault, factory }],
  }
  mocks.post.mockResolvedValue({ data: { data: { _meta: laggingData._meta } } })
  const fetch = vi.fn(async () => Response.json({ data: laggingData }))
  vi.stubGlobal('fetch', fetch)
  const buildQuery = withCheckedSubgraphQueries(sdkBuildQuery, source === 'direct'
    ? { [chainId]: url }
    : async () => ({ endpoint: url, deploymentId: 'selected', identity: 'catalog-selection' }))
  const config = { subgraphURLs: { [chainId]: url } }
  const accounts = new AccountVaultsSubgraphAdapter(config, buildQuery)
  const factories = new VaultTypeSubgraphAdapter(config, buildQuery)
  const triggerPortfolioRefresh = vi.fn()
  const refresh = refreshPortfolioAfterReviewedSubmission({ chainId, confirmedBlockNumber: 123n, triggerPortfolioRefresh })

  const expectDiscoveryAvailable = async () => {
    const results: unknown[] = []
    void Promise.all([
      accounts.fetchAccountVaults(chainId, account),
      factories.fetchVaultFactories(chainId, [vault]),
    ]).then(value => results.push(value), error => results.push(error))
    await vi.advanceTimersByTimeAsync(50)
    expect(results).toEqual([[{ [account]: { deposits: [vault], borrows: [] } }, [{ id: vault, factory }]]])
  }

  await expectDiscoveryAvailable()
  expect(triggerPortfolioRefresh).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(30_000)
  await refresh
  expect(triggerPortfolioRefresh).toHaveBeenCalledOnce()
  await expectDiscoveryAvailable()
  expect(fetch).toHaveBeenCalledTimes(4)
})
