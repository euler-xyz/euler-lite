import { getAddress, type Address } from 'viem'
import type { TransactionPlan, UserReward } from '@eulerxyz/euler-v2-sdk'

export const useSdkRewards = () => {
  const { portfolio, isPositionsLoading, refreshAllPositions } = useEulerAccount()
  const { address: walletAddress } = useWagmi()

  const rewards = computed<UserReward[]>(() => portfolio.value?.account.userRewards ?? [])
  const isRewardsLoading = computed(() => isPositionsLoading.value)

  const buildClaimRewardPlan = async (reward: UserReward): Promise<TransactionPlan> => {
    if (!walletAddress.value) {
      throw new Error('Wallet not connected')
    }

    const { getEulerSdk } = useEulerSdk()
    const sdk = await getEulerSdk()
    return sdk.rewardsService.buildClaimPlan({
      reward,
      account: getAddress(walletAddress.value) as Address,
    })
  }

  const refreshRewards = async () => {
    await refreshAllPositions()
  }

  return {
    rewards,
    isRewardsLoading,
    buildClaimRewardPlan,
    refreshRewards,
  }
}
