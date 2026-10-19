import { afterEach, expect, it, vi } from 'vitest'
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
  sdkQueryClient.clear()
})

it('post-tx refresh checks new discovery and an old in-flight response against the confirmed block', async () => {
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
  expect(fetch).toHaveBeenCalledTimes(3)
})
