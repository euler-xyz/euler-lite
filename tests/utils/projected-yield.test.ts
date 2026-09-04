import { describe, expect, it } from 'vitest'
import type { RewardCampaign } from '~/entities/reward-campaign'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'
import {
  getCollateralSnapshotRateLines,
  getProjectedRewardAprPresentation,
  getProjectedYieldState,
  mergeProjectedRewardCampaigns,
  projectedYieldHasRewards,
  type ProjectedYieldDetails,
} from '~/utils/projected-yield'

const renderedRewardApr = (before: number | null | undefined, after: number | null | undefined) => {
  const presentation = getProjectedRewardAprPresentation(before, after)
  return presentation.before
    ? `${presentation.before} → ${presentation.after}`
    : presentation.after
}

const campaign = (overrides: Partial<RewardCampaign>): RewardCampaign => ({
  campaignId: 'campaign',
  source: 'merkl',
  action: 'LEND',
  apr: 0.01,
  rewardTokenSymbol: 'RWD',
  rewardTokenIcon: '/rwd.png',
  ...overrides,
} as RewardCampaign)

describe('getProjectedYieldState', () => {
  const inputs = {
    supplyUsd: 200,
    baseSupplyApy: 4,
    intrinsicSupplyApy: 1,
    supplyRewardApy: 2,
    borrowUsd: 100,
    baseBorrowApy: 6,
    intrinsicBorrowApy: 0.5,
    borrowRewardApy: 1,
    loopingRewardApy: 3,
  }

  it('uses supplied value as the Net APY denominator', () => {
    const state = getProjectedYieldState('net-apy', inputs)
    expect(state?.breakdown).toEqual({
      lending: 4,
      borrowing: -3,
      rewards: 4,
      intrinsicApy: 0.75,
      total: 5.75,
    })
  })

  it('uses equity as the ROE denominator', () => {
    const state = getProjectedYieldState('roe', inputs)
    expect(state?.breakdown).toEqual({
      lending: 8,
      borrowing: -6,
      rewards: 8,
      intrinsicApy: 1.5,
      total: 11.5,
    })
  })

  it('fails closed for non-finite inputs', () => {
    expect(getProjectedYieldState('net-apy', { ...inputs, supplyUsd: Number.NaN })).toBeNull()
  })
})

describe('mergeProjectedRewardCampaigns', () => {
  it('keeps different reward assets and before/after eligibility separate', () => {
    const oldReward = campaign({ campaignId: 'old', rewardTokenSymbol: 'OLD' })
    const retainedReward = campaign({ campaignId: 'same', action: 'BORROW', rewardTokenSymbol: 'KEEP' })
    const newReward = campaign({ campaignId: 'new', action: 'LOOPING', rewardTokenSymbol: 'NEW', apr: 0.02 })

    const lines = mergeProjectedRewardCampaigns(
      [
        { campaign: oldReward, vaultAddress: '0x1' },
        { campaign: retainedReward, vaultAddress: '0x2' },
      ],
      [
        { campaign: retainedReward, vaultAddress: '0x2' },
        { campaign: newReward, vaultAddress: '0x2' },
      ],
    )

    expect(lines.map(line => line.rewardToken.symbol)).toEqual(['KEEP', 'NEW', 'OLD'])
    expect(lines.find(line => line.rewardToken.symbol === 'KEEP')).toMatchObject({
      vaultAddress: '0x2',
      beforeApr: 1,
      afterApr: 1,
    })
    expect(lines.find(line => line.rewardToken.symbol === 'NEW')?.beforeApr).toBeUndefined()
    expect(lines.find(line => line.rewardToken.symbol === 'NEW')).toMatchObject({ afterApr: 2 })
    expect(lines.find(line => line.rewardToken.symbol === 'OLD')).toMatchObject({ beforeApr: 1 })
    expect(lines.find(line => line.rewardToken.symbol === 'OLD')?.afterApr).toBeUndefined()
  })

  it('keeps same-token campaigns for different collateral vaults identifiable', () => {
    const firstCollateral = campaign({
      campaignId: 'same',
      action: 'BORROW_COLLATERAL',
      collateralAddress: '0xaaa',
    })
    const secondCollateral = campaign({
      campaignId: 'same',
      action: 'BORROW_COLLATERAL',
      collateralAddress: '0xbbb',
    })

    const lines = mergeProjectedRewardCampaigns([], [
      { campaign: firstCollateral, vaultAddress: '0xdebt' },
      { campaign: secondCollateral, vaultAddress: '0xdebt' },
    ])

    expect(lines).toHaveLength(2)
    expect(lines.map(line => line.collateralAddress)).toEqual(['0xaaa', '0xbbb'])
    expect(lines.every(line => line.vaultAddress === '0xdebt')).toBe(true)
  })

  it('preserves the generic eligibility notice for projected rewards', () => {
    const lines = mergeProjectedRewardCampaigns([], [{
      campaign: campaign({
        sourceUrl: 'https://app.merkl.xyz/opportunities/ethereum/EULER/example',
        eligibilityRequirements: [{ type: 'provider-defined' }],
      }),
      vaultAddress: '0x1',
    }])

    expect(lines[0]).toMatchObject({
      sourceUrl: 'https://app.merkl.xyz/opportunities/ethereum/EULER/example',
      eligibilityLabel: 'eligibility requirements apply; see Merkl for details',
    })
  })

  it('shows sparkles for rewards that exist in either state', () => {
    const state = getProjectedYieldState('net-apy', {
      supplyUsd: 100,
      baseSupplyApy: 1,
      supplyRewardApy: 1,
      borrowUsd: 0,
      baseBorrowApy: 0,
    })!
    const details: ProjectedYieldDetails = {
      metric: 'net-apy',
      before: state,
      after: { total: 1, breakdown: { ...state.breakdown, rewards: 0, total: 1 } },
      rateLines: [],
      rewards: [],
    }
    expect(projectedYieldHasRewards(details)).toBe(true)
  })
})

describe('getProjectedRewardAprPresentation', () => {
  it('renders only the projected APR when the current campaign is missing or inapplicable', () => {
    expect(renderedRewardApr(undefined, 7.23)).toBe('7.23%')
    expect(renderedRewardApr(null, 7.23)).toBe('7.23%')
  })

  it('preserves a real zero current APR as an explicit transition', () => {
    expect(renderedRewardApr(0, 7.23)).toBe('0.00% → 7.23%')
  })

  it('renders the normal transition when positive current and projected APRs differ', () => {
    expect(renderedRewardApr(4.56, 7.23)).toBe('4.56% → 7.23%')
  })

  it('preserves the single-value presentation when current and projected APRs are equal', () => {
    expect(renderedRewardApr(7.23, 7.23)).toBe('7.23%')
  })

  it('preserves the transition to missing when there is no projected campaign', () => {
    expect(renderedRewardApr(7.23, undefined)).toBe('7.23% → -')
    expect(renderedRewardApr(7.23, null)).toBe('7.23% → -')
  })
})

describe('getCollateralSnapshotRateLines', () => {
  it('preserves vault identity when multiple collateral vaults share a symbol', () => {
    const makeSnapshot = (apy: number): CollateralApySnapshot => ({
      entries: ['0xaaa', '0xbbb'].map(address => ({
        address,
        vault: { asset: { symbol: 'WETH' } },
        baseSupplyApy: apy,
      })),
    } as unknown as CollateralApySnapshot)

    const lines = getCollateralSnapshotRateLines(makeSnapshot(1), makeSnapshot(2))

    expect(lines).toHaveLength(2)
    expect(lines.map(line => line.vaultAddress)).toEqual(['0xaaa', '0xbbb'])
  })
})
