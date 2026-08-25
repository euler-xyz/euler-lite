import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { refreshPortfolioAfterReviewedSubmission } from '~/features/reviewed-execution/review/post-tx-refresh'

const mocks = vi.hoisted(() => ({
  buildSubgraphProxyApiPath: vi.fn((chainId: number) => `/api/internal/proxy/subgraph/${chainId}`),
  invalidateSdkQueries: vi.fn(async () => {}),
  logWarn: vi.fn(),
  waitForSubgraphBlock: vi.fn(async () => true),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  buildSubgraphProxyApiPath: mocks.buildSubgraphProxyApiPath,
}))
vi.mock('~/utils/errorHandling', () => ({ logWarn: mocks.logWarn }))
vi.mock('~/utils/sdk-query-cache', () => ({ invalidateSdkQueries: mocks.invalidateSdkQueries }))
vi.mock('~/utils/subgraph', () => ({ waitForSubgraphBlock: mocks.waitForSubgraphBlock }))

describe('refreshPortfolioAfterReviewedSubmission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.waitForSubgraphBlock.mockResolvedValue(true)
  })

  it('refreshes immediately and again after account discovery reaches the confirmed block', async () => {
    const triggerPortfolioRefresh = vi.fn()

    await refreshPortfolioAfterReviewedSubmission({
      chainId: 1,
      confirmedBlockNumber: 123n,
      triggerPortfolioRefresh,
    })

    expect(mocks.waitForSubgraphBlock).toHaveBeenCalledWith('/api/internal/proxy/subgraph/1', 123n)
    expect(mocks.invalidateSdkQueries).toHaveBeenCalledTimes(2)
    expect(mocks.invalidateSdkQueries).toHaveBeenNthCalledWith(1, [...INVALIDATE_AFTER_TX])
    expect(mocks.invalidateSdkQueries).toHaveBeenNthCalledWith(2, [...INVALIDATE_AFTER_TX])
    expect(triggerPortfolioRefresh).toHaveBeenCalledTimes(2)
  })

  it('keeps the immediate refresh when no confirmed block is available', async () => {
    const triggerPortfolioRefresh = vi.fn()

    await refreshPortfolioAfterReviewedSubmission({ chainId: 1, triggerPortfolioRefresh })

    expect(mocks.waitForSubgraphBlock).not.toHaveBeenCalled()
    expect(mocks.invalidateSdkQueries).toHaveBeenCalledOnce()
    expect(triggerPortfolioRefresh).toHaveBeenCalledOnce()
  })

  it('keeps only the immediate refresh and reports a catch-up timeout', async () => {
    const triggerPortfolioRefresh = vi.fn()
    mocks.waitForSubgraphBlock.mockResolvedValue(false)

    await refreshPortfolioAfterReviewedSubmission({
      chainId: 1,
      confirmedBlockNumber: 123n,
      triggerPortfolioRefresh,
    })

    expect(mocks.invalidateSdkQueries).toHaveBeenCalledOnce()
    expect(triggerPortfolioRefresh).toHaveBeenCalledOnce()
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'reviewedExecution/subgraphPoll',
      expect.objectContaining({ message: 'subgraph did not catch up to block 123 in time' }),
    )
  })
})
