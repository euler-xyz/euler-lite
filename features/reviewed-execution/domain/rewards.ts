import { getAddress, type Hash } from 'viem'
import type { UserReward } from '~/entities/reward-campaign'
import { canonicalDigest, toCanonicalValue } from './canonical'

export const rewardClaimId = (reward: UserReward): string => [
  reward.chainId,
  reward.provider,
  reward.claimAddress?.toLowerCase() ?? '',
  reward.campaignId ?? '',
  reward.streamId ?? '',
  reward.token.address.toLowerCase(),
  reward.unclaimed,
].join(':')

const claimBearingReward = (reward: UserReward) => ({
  chainId: reward.chainId,
  token: {
    address: getAddress(reward.token.address),
    chainId: reward.token.chainId,
    symbol: reward.token.symbol,
    name: reward.token.name,
    decimals: reward.token.decimals,
  },
  provider: reward.provider,
  campaignId: reward.campaignId,
  accumulated: reward.accumulated,
  unclaimed: reward.unclaimed,
  proof: reward.proof,
  claimAddress: reward.claimAddress ? getAddress(reward.claimAddress) : undefined,
  cumulativeAmounts: reward.cumulativeAmounts,
  epoch: reward.epoch,
  streamId: reward.streamId,
  streamAddress: reward.streamAddress ? getAddress(reward.streamAddress) : undefined,
  timestamp: reward.timestamp,
})

export const rewardClaimSetDigest = (rewards: readonly UserReward[]): Hash =>
  canonicalDigest('reward-claim-set-v1', toCanonicalValue(
    [...rewards]
      .sort((left, right) => rewardClaimId(left).localeCompare(rewardClaimId(right)))
      .map(claimBearingReward),
  ))
