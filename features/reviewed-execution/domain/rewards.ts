import { getAddress, type Hash } from 'viem'
import type { UserReward } from '~/entities/reward-campaign'
import { rewardUnclaimedAmount } from '~/entities/reward-campaign'
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

/**
 * The reward as it was when the user clicked, together with the two values
 * derived from it that the review states.
 *
 * Claiming awaits a wallet network switch, and the portfolio list behind it
 * can refresh while that is pending. Everything the review shows and signs
 * therefore has to come from one frozen reward rather than from the live row,
 * or the amount can describe a reward the intent no longer refers to.
 */
export interface RewardClaimSnapshot {
  reward: UserReward
  claimId: string
  decimals: number
  amount: number
}

/** `undefined` when the token's decimals are unresolved, so no amount can be stated. */
export const rewardClaimSnapshot = (reward: UserReward): RewardClaimSnapshot | undefined => {
  const { decimals } = reward.token
  const amount = rewardUnclaimedAmount(reward)
  if (decimals === undefined || amount === undefined) return undefined
  return { reward, claimId: rewardClaimId(reward), decimals, amount }
}

/**
 * True when the live reward no longer matches the snapshot the review was
 * built from. `rewardClaimId` covers the chain, provider, campaign, token and
 * unclaimed amount; decimals are compared separately because a token that
 * stops resolving keeps the same claim id.
 */
export const hasRewardDrifted = (
  snapshot: RewardClaimSnapshot,
  current: UserReward,
): boolean =>
  rewardClaimId(current) !== snapshot.claimId
  || current.token.decimals !== snapshot.decimals
