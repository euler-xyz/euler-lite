import type { TransactionPlan, UserReward } from '@eulerxyz/euler-v2-sdk'
import type { TxPlan, TxStep } from '~/entities/txPlan'

export type RewardPlanKind = 'reward' | 'brevis-reward' | 'fuul-reward'

export const getRewardProviderLabel = (provider: UserReward['provider']) => {
  if (provider === 'merkl') return 'Merkl'
  if (provider === 'brevis') return 'Incentra'
  if (provider === 'fuul') return 'Fuul'
  return provider
}

export const getRewardPlanKind = (provider: UserReward['provider']): RewardPlanKind => {
  if (provider === 'brevis') return 'brevis-reward'
  if (provider === 'fuul') return 'fuul-reward'
  return 'reward'
}

export const sdkRewardPlanToTxPlan = (
  plan: TransactionPlan,
  kind: RewardPlanKind,
): TxPlan => ({
  kind,
  steps: plan.map((item): TxStep => {
    if (item.type !== 'contractCall') {
      throw new Error(`Unsupported reward plan item: ${item.type}`)
    }

    return {
      type: 'other',
      label: 'Claim reward',
      to: item.to,
      abi: item.abi,
      functionName: item.functionName,
      args: item.args,
      value: item.value,
    }
  }),
})
