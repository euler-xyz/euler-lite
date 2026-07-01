import { getAddress, type Address } from 'viem'
import type { EulerSDKQueryName, TransactionPlan, UserReward } from '@eulerxyz/euler-v2-sdk'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'

const USER_REWARD_QUERY_NAMES: EulerSDKQueryName[] = [
  'queryMerklUserRewards',
  'queryBrevisCampaigns',
  'queryBrevisUserProofs',
  'queryFuulClaimableRewards' as EulerSDKQueryName,
  'queryTurtleMerkleProofs' as EulerSDKQueryName,
]
const REWARD_CLAIM_REFRESH_RETRY_DELAYS_MS = [5_000, 30_000] as const

type RefreshRewardsOptions = {
  delayedRetry?: boolean
}

let delayedRefreshTimers: ReturnType<typeof setTimeout>[] = []

export const useSdkRewards = () => {
  const { portfolio, isPositionsLoading, refreshAllPositions } = useEulerAccount()
  const { chainId } = useEulerAddresses()
  const { address: walletAddress, isConnected } = useWagmi()
  const { isSpyMode } = useSpyMode()
  const hasActiveSession = computed(() => isConnected.value || isSpyMode.value)

  const rewards = computed<UserReward[]>(() => {
    const items = portfolio.value?.account.userRewards ?? []
    const currentChainId = chainId.value
    if (!currentChainId) return []
    return items.filter(reward => reward.chainId === currentChainId)
  })
  const isRewardsLoading = computed(() => hasActiveSession.value && isPositionsLoading.value)

  const buildClaimRewardPlan = async (reward: UserReward): Promise<TransactionPlan> => {
    if (!walletAddress.value) {
      throw new Error('Wallet not connected')
    }

    const { getEulerSdk } = useEulerSdk()
    const sdk = await getEulerSdk()
    const account = getAddress(walletAddress.value) as Address

    return sdk.rewardsService.buildClaimPlan({
      reward,
      account,
    })
  }

  const runRewardsRefresh = async () => {
    await invalidateSdkQueries(USER_REWARD_QUERY_NAMES)
    await refreshAllPositions(undefined, undefined, { source: 'fresh', preempt: true })
  }

  const queueDelayedRefresh = () => {
    delayedRefreshTimers.forEach(timer => clearTimeout(timer))
    delayedRefreshTimers = REWARD_CLAIM_REFRESH_RETRY_DELAYS_MS.map((delay) => {
      const timer = setTimeout(() => {
        delayedRefreshTimers = delayedRefreshTimers.filter(activeTimer => activeTimer !== timer)
        void runRewardsRefresh()
      }, delay)
      return timer
    })
  }

  const refreshRewards = async (options: RefreshRewardsOptions = {}) => {
    await runRewardsRefresh()
    if (options.delayedRetry) queueDelayedRefresh()
  }

  return {
    rewards,
    isRewardsLoading,
    buildClaimRewardPlan,
    refreshRewards,
  }
}
