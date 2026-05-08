import { getAddress, type Address } from 'viem'
import type { UserReward } from '@eulerxyz/euler-v2-sdk'
import type { TxPlan } from '~/entities/txPlan'
import { getRewardPlanKind, sdkRewardPlanToTxPlan } from '~/utils/sdk-rewards'

export const useSdkRewards = () => {
  const { portfolio, isPositionsLoading, refreshAllPositions } = useEulerAccount()
  const { address: walletAddress } = useWagmi()

  const rewards = computed<UserReward[]>(() => portfolio.value?.account.userRewards ?? [])
  const isRewardsLoading = computed(() => isPositionsLoading.value)

  const buildClaimRewardPlan = async (reward: UserReward): Promise<TxPlan> => {
    if (!walletAddress.value) {
      throw new Error('Wallet not connected')
    }

    const { getEulerSdk } = useEulerSdk()
    const sdk = await getEulerSdk()
    const plan = await sdk.rewardsService.buildClaimPlan({
      reward,
      account: getAddress(walletAddress.value) as Address,
    })

    return sdkRewardPlanToTxPlan(plan, getRewardPlanKind(reward.provider))
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
