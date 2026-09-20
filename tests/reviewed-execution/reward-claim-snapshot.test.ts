import { describe, expect, it } from 'vitest'
import type { UserReward } from '~/entities/reward-campaign'
import {
  hasRewardDrifted,
  rewardClaimId,
  rewardClaimSnapshot,
} from '~/features/reviewed-execution/domain/rewards'

const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const makeReward = (overrides: Partial<UserReward> & { decimals?: number } = {}): UserReward => {
  // Destructuring with a default would turn an explicit `decimals: undefined`
  // — the unresolved case under test — back into 6.
  const { decimals, ...rest } = 'decimals' in overrides ? overrides : { ...overrides, decimals: 6 }
  return {
    provider: 'turtle',
    chainId: 1,
    token: {
      address: usdcAddress,
      chainId: 1,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals,
    },
    tokenPrice: 1,
    accumulated: '603375',
    unclaimed: '603375',
    campaignId: '4242c3ea-b6cc-46d5-8592-d072620b51bc',
    ...rest,
  } as unknown as UserReward
}

describe('rewardClaimSnapshot', () => {
  it('states the amount and decimals the review was built from', () => {
    const reward = makeReward()
    const snapshot = rewardClaimSnapshot(reward)

    expect(snapshot).toEqual({
      reward,
      claimId: rewardClaimId(reward),
      decimals: 6,
      amount: 0.603375,
    })
  })

  it('refuses a reward whose decimals never resolved', () => {
    expect(rewardClaimSnapshot(makeReward({ decimals: undefined }))).toBeUndefined()
  })

  it('keeps a genuine zero-decimal token', () => {
    expect(rewardClaimSnapshot(makeReward({ decimals: 0 }))).toMatchObject({
      decimals: 0,
      amount: 603375,
    })
  })
})

describe('hasRewardDrifted', () => {
  // The claim awaits a wallet network switch, and the portfolio list can
  // refresh while it is pending: the review must not pair the amount captured
  // at click time with a reward the list has since replaced.
  const snapshot = rewardClaimSnapshot(makeReward())!

  it('accepts the reward the snapshot was taken from', () => {
    expect(hasRewardDrifted(snapshot, makeReward())).toBe(false)
  })

  it('rejects a refreshed amount', () => {
    const refreshed = makeReward({ accumulated: '2020000', unclaimed: '2020000' })
    expect(hasRewardDrifted(snapshot, refreshed)).toBe(true)
  })

  it('rejects a token that stopped resolving at the same amount', () => {
    expect(hasRewardDrifted(snapshot, makeReward({ decimals: undefined }))).toBe(true)
  })

  it('rejects a different token or campaign', () => {
    const otherToken = makeReward()
    otherToken.token.address = '0x0000000000000000000000000000000000000009'
    expect(hasRewardDrifted(snapshot, otherToken)).toBe(true)
    expect(hasRewardDrifted(snapshot, makeReward({ campaignId: 'other' }))).toBe(true)
  })
})
