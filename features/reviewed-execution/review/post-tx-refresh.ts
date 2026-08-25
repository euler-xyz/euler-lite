import { buildSubgraphProxyApiPath } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { advanceSdkQueryGeneration, invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { waitForSubgraphBlock } from '~/utils/subgraph'

const triggerRefresh = (triggerPortfolioRefresh: () => void, forceFresh = false) => {
  const invalidation = forceFresh
    ? advanceSdkQueryGeneration([...INVALIDATE_AFTER_TX])
    : invalidateSdkQueries([...INVALIDATE_AFTER_TX])
  void invalidation
    .catch(error => logWarn('reviewedExecution/queryInvalidation', error))
  triggerPortfolioRefresh()
}

/**
 * Refresh immediately after a terminal submission outcome. When a confirmed
 * block is available, refresh discovery data again once the subgraph serving
 * account-vault membership has indexed that block.
 */
export const refreshPortfolioAfterReviewedSubmission = async ({
  chainId,
  confirmedBlockNumber,
  triggerPortfolioRefresh,
}: {
  chainId: number
  confirmedBlockNumber?: bigint
  triggerPortfolioRefresh: () => void
}) => {
  triggerRefresh(triggerPortfolioRefresh)
  if (confirmedBlockNumber === undefined) return

  const caughtUp = await waitForSubgraphBlock(
    buildSubgraphProxyApiPath(chainId),
    confirmedBlockNumber,
  )
  if (!caughtUp) {
    logWarn(
      'reviewedExecution/subgraphPoll',
      new Error(`subgraph did not catch up to block ${confirmedBlockNumber} in time`),
    )
    return
  }
  triggerRefresh(triggerPortfolioRefresh, true)
}
