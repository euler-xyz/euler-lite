import { computed, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RewardCampaign } from '@eulerxyz/euler-v2-sdk'
import { useRewardsApy } from '~/composables/useRewardsApy'

vi.mock('~/entities/reward-campaign', () => ({
  isCampaignEligibleForAddress: vi.fn(() => true),
  rewardCampaignAprPercent: vi.fn((campaign: { apr: number }) => campaign.apr),
}))

const BORROW = '0x0000000000000000000000000000000000000001'
const COLLATERAL_A = '0x0000000000000000000000000000000000000002'
const COLLATERAL_B = '0x0000000000000000000000000000000000000003'

const campaign = (
  action: RewardCampaign['action'],
  apr: number,
  collateralAddress?: string,
  minMultiplier?: number,
  maxMultiplier?: number,
) => ({
  action,
  apr,
  source: 'merkl',
  collateralAddress,
  minMultiplier,
  maxMultiplier,
}) as unknown as RewardCampaign

describe('useRewardsApy multi-collateral rewards', () => {
  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableRewardsApy: true }) }))
    vi.stubGlobal('useDeployConfig', () => ({
      enableMerkl: true,
      enableIncentra: true,
      enableFuul: true,
      enableTurtle: true,
    }))
    vi.stubGlobal('useWagmi', () => ({ address: ref(undefined) }))
    vi.stubGlobal('useSpyMode', () => ({ spyAddress: ref(undefined) }))
    vi.stubGlobal('useVaultRegistry', () => ({
      registryVersion: ref(1),
      getVault: vi.fn(() => ({
        rewards: {
          getActiveCampaigns: () => [
            campaign('BORROW', 1),
            campaign('BORROW_COLLATERAL', 2, COLLATERAL_A),
            campaign('BORROW_COLLATERAL', 3, COLLATERAL_B),
            campaign('LOOPING', 4, COLLATERAL_A, 2, 3),
            campaign('LOOPING', 5, COLLATERAL_B, 2, 3),
          ],
        },
      })),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('includes base borrow and every matching collateral campaign once', () => {
    const { getBorrowRewardApyForCollaterals } = useRewardsApy()

    expect(getBorrowRewardApyForCollaterals(BORROW, [COLLATERAL_A, COLLATERAL_B])).toBe(6)
  })

  it('includes looping rewards only for matching collateral and multiplier', () => {
    const { getEligibleLoopingRewardApyForCollaterals } = useRewardsApy()

    expect(getEligibleLoopingRewardApyForCollaterals(BORROW, [COLLATERAL_A, COLLATERAL_B], 2.5)).toBe(9)
    expect(getEligibleLoopingRewardApyForCollaterals(BORROW, [COLLATERAL_A, COLLATERAL_B], 4)).toBe(0)
    expect(getEligibleLoopingRewardApyForCollaterals(BORROW, [COLLATERAL_A], null)).toBe(0)
  })
})
