import type { BatchEntry } from '~/composables/useTxBatch'
import { REWARD_PROVIDER_REVIEW_TYPES } from '~/entities/reward-campaign'

const REWARD_REVIEW_TYPES = new Set<string>(Object.values(REWARD_PROVIDER_REVIEW_TYPES))

export const hasEarlierREULClaim = (
  entries: readonly Pick<BatchEntry, 'review'>[],
  reulAddress: string,
): boolean => {
  const normalizedREULAddress = reulAddress.toLowerCase()
  if (!normalizedREULAddress) return false

  return entries.some((entry) => {
    const review = entry.review
    if (!review || typeof review.type !== 'string' || !REWARD_REVIEW_TYPES.has(review.type)) {
      return false
    }

    const asset = review.asset
    if (!asset || typeof asset !== 'object' || !('address' in asset)) return false
    const claimTokenAddress = (asset as { address?: unknown }).address

    return typeof claimTokenAddress === 'string'
      && claimTokenAddress.toLowerCase() === normalizedREULAddress
  })
}
