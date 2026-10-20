import { buildSubgraphProxyApiPath } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { advanceSdkQueryGeneration, invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { waitForSubgraphBlock } from '~/utils/subgraph'
import { requireFreshPlanningAccount } from '~/utils/planning-account-freshness'

const triggerRefresh = (triggerPortfolioRefresh: () => void) => {
  const invalidation = invalidateSdkQueries([...INVALIDATE_AFTER_TX])
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
  const waitForPlanningRefresh = confirmedBlockNumber === undefined
    ? undefined
    : requireFreshPlanningAccount(
        chainId,
        confirmedBlockNumber,
        async () => {
          const caughtUp = await waitForSubgraphBlock(buildSubgraphProxyApiPath(chainId), confirmedBlockNumber)
          if (!caughtUp) throw new Error('Account is still updating after your transaction. Please refresh and try again.')
          // The planning read must not join a request started before indexer catch-up.
          await advanceSdkQueryGeneration([...INVALIDATE_AFTER_TX])
        },
      )
  triggerRefresh(triggerPortfolioRefresh)
  if (!waitForPlanningRefresh) return

  try {
    await waitForPlanningRefresh()
  }
  catch (error) {
    logWarn('reviewedExecution/subgraphPoll', error)
    return
  }
  triggerPortfolioRefresh()
}
