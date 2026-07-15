import { describe, expect, it } from 'vitest'
import type { EVault, RewardCampaign } from '@eulerxyz/euler-v2-sdk'
import { computeBorrowApy } from '~/utils/collateralOptions'

const COLLATERAL = '0x0000000000000000000000000000000000000001'
const OTHER_COLLATERAL = '0x0000000000000000000000000000000000000002'

const campaign = (
  campaignId: string,
  action: RewardCampaign['action'],
  apr: number,
  collateralAddress?: string,
): RewardCampaign => ({
  campaignId,
  source: 'merkl',
  action,
  apr,
  rewardTokenSymbol: 'RWD',
  ...(collateralAddress ? { collateralAddress } : {}),
} as RewardCampaign)

describe('computeBorrowApy', () => {
  it('subtracts general and matching collateral rewards from visible borrow cost', () => {
    const vault = {
      interestRates: { borrowAPY: 6 },
      intrinsicApy: { apy: 1 },
      rewards: {
        getActiveCampaigns: () => [
          campaign('general', 'BORROW', 0.0025),
          campaign('matching', 'BORROW_COLLATERAL', 0.0075, COLLATERAL),
          campaign('other', 'BORROW_COLLATERAL', 0.01, OTHER_COLLATERAL),
        ],
      },
    } as unknown as EVault

    expect(computeBorrowApy(vault, undefined, {
      enableIntrinsicApy: true,
      enableRewardsApy: true,
    }, COLLATERAL)).toBeCloseTo(6.06)
  })
})
