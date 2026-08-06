import { describe, expect, it } from 'vitest'
import { hasEarlierREULClaim } from '~/components/entities/reward/reulUnlockBatchSafety'
import { REWARD_PROVIDER_REVIEW_TYPES } from '~/entities/reward-campaign'

const REUL = '0xf3e621395fc714B90dA337AA9108771597b4E696'

const entryWithReview = (review: Record<string, unknown>) => ({ review })

describe('hasEarlierREULClaim', () => {
  it('detects an earlier reward claim that credits rEUL', () => {
    expect(hasEarlierREULClaim([
      entryWithReview({
        type: 'reward',
        asset: { address: REUL.toLowerCase(), symbol: 'rEUL' },
      }),
    ], REUL)).toBe(true)
  })

  it('detects every reward claim review type by the claimed token address', () => {
    for (const type of Object.values(REWARD_PROVIDER_REVIEW_TYPES)) {
      expect(hasEarlierREULClaim([
        entryWithReview({ type, asset: { address: REUL } }),
      ], REUL)).toBe(true)
    }
  })

  it('ignores non-claim operations and claims of other tokens', () => {
    expect(hasEarlierREULClaim([
      entryWithReview({ type: 'supply', asset: { address: REUL } }),
      entryWithReview({
        type: 'reward',
        asset: { address: '0x0000000000000000000000000000000000000001' },
      }),
    ], REUL)).toBe(false)
  })

  it('does not match without a configured rEUL address', () => {
    expect(hasEarlierREULClaim([
      entryWithReview({ type: 'reward', asset: { address: REUL } }),
    ], '')).toBe(false)
  })
})
