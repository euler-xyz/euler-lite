import { describe, expect, it } from 'vitest'
import { isCampaignEligibleForAddress, rewardCampaignDisplay, rewardCampaignEligibilityLabel, rewardUnclaimedAmount, rewardUnclaimedUsdValue } from '~/entities/reward-campaign'
import type { RewardCampaign, UserReward } from '~/entities/reward-campaign'

const USER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
const OTHER = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb'

describe('isCampaignEligibleForAddress', () => {
  it('returns true when no user address is supplied (headline APR stays visible)', () => {
    expect(isCampaignEligibleForAddress({}, undefined)).toBe(true)
    expect(isCampaignEligibleForAddress({ whitelist: [USER.toLowerCase()] }, null)).toBe(true)
    expect(isCampaignEligibleForAddress({ blacklist: [USER.toLowerCase()] }, '')).toBe(true)
  })

  it('returns true when neither whitelist nor blacklist is present', () => {
    expect(isCampaignEligibleForAddress({}, USER)).toBe(true)
  })

  describe('whitelist semantics', () => {
    it('returns true when the user is on a non-empty whitelist', () => {
      expect(isCampaignEligibleForAddress({ whitelist: [USER.toLowerCase()] }, USER)).toBe(true)
    })

    it('returns false when the user is not on a non-empty whitelist', () => {
      expect(isCampaignEligibleForAddress({ whitelist: [OTHER.toLowerCase()] }, USER)).toBe(false)
    })

    it('treats an empty whitelist as absent (does not exclude everyone)', () => {
      expect(isCampaignEligibleForAddress({ whitelist: [] }, USER)).toBe(true)
    })

    it('whitelist membership overrides blacklist membership', () => {
      expect(isCampaignEligibleForAddress({
        whitelist: [USER.toLowerCase()],
        blacklist: [USER.toLowerCase()],
      }, USER)).toBe(true)
    })
  })

  describe('blacklist semantics', () => {
    it('returns false when the user is on the blacklist (and no whitelist is set)', () => {
      expect(isCampaignEligibleForAddress({ blacklist: [USER.toLowerCase()] }, USER)).toBe(false)
    })

    it('returns true when the user is not on the blacklist', () => {
      expect(isCampaignEligibleForAddress({ blacklist: [OTHER.toLowerCase()] }, USER)).toBe(true)
    })
  })

  it('matches addresses case-insensitively (stored lowercase, user may be mixed-case)', () => {
    expect(isCampaignEligibleForAddress({ blacklist: [USER.toLowerCase()] }, USER)).toBe(false)
    expect(isCampaignEligibleForAddress({ whitelist: [USER.toLowerCase()] }, USER.toUpperCase())).toBe(true)
  })
})

describe('rewardCampaignDisplay', () => {
  const baseCampaign: RewardCampaign = {
    campaignId: 'campaign-1',
    source: 'merkl',
    action: 'LEND',
    apr: 0.01,
    rewardTokenSymbol: 'WMON',
  }

  it('does not link Merkl campaigns without an exact opportunity URL', () => {
    expect(rewardCampaignDisplay(baseCampaign).sourceUrl).toBeUndefined()
  })

  it('keeps provider sourceUrl when the campaign supplies one', () => {
    expect(rewardCampaignDisplay({
      ...baseCampaign,
      sourceUrl: 'https://app.merkl.xyz/opportunities/monad/EULER/example',
    }).sourceUrl).toBe('https://app.merkl.xyz/opportunities/monad/EULER/example')
  })

  it.each([
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/drainer',
  ])('drops an unsafe provider sourceUrl (%s)', (sourceUrl) => {
    expect(rewardCampaignDisplay({ ...baseCampaign, sourceUrl }).sourceUrl).toBeUndefined()
  })

  it('does not disguise a rejected URL with a provider fallback', () => {
    expect(rewardCampaignDisplay({
      ...baseCampaign,
      source: 'turtle',
      sourceUrl: 'javascript:alert(1)',
    }).sourceUrl).toBeUndefined()
  })

  it('links Turtle campaigns to the Turtle stream dashboard', () => {
    expect(rewardCampaignDisplay({
      ...baseCampaign,
      campaignId: '557af9e9-88e8-4233-95e1-630b8b37b613',
      source: 'turtle',
    }).sourceUrl).toBe('https://dashboard.turtle.xyz/organizations/52974bc3-2c43-4576-ac18-107d92b6e0c7/incentives/streams/557af9e9-88e8-4233-95e1-630b8b37b613')
  })

  it('shows a generic notice when eligibility requirements are present', () => {
    expect(rewardCampaignDisplay({
      ...baseCampaign,
      eligibilityRequirements: [{
        type: 'provider-defined',
        details: { canChangeWithoutLiteSupport: true },
      }],
    }).eligibilityLabel).toBe('eligibility requirements apply')
  })

  it('shows a generic notice for complete eligibility metadata without modeled requirements', () => {
    expect(rewardCampaignDisplay({
      ...baseCampaign,
      sourceUrl: 'https://app.merkl.xyz/opportunities/monad/EULER/example',
      eligibilityRequirementsStatus: 'complete',
    }).eligibilityLabel).toBe('eligibility requirements apply')
  })

  it('distinguishes incomplete eligibility metadata from confirmed requirements', () => {
    expect(rewardCampaignDisplay({
      ...baseCampaign,
      sourceUrl: 'https://app.merkl.xyz/opportunities/monad/EULER/example',
      eligibilityRequirementsStatus: 'incomplete',
    }).eligibilityLabel).toBe('eligibility information may be incomplete; additional requirements may apply')
  })

  it('does not interpret provider-specific eligibility details', () => {
    expect(rewardCampaignEligibilityLabel({
      source: 'merkl',
      eligibilityRequirements: [{
        type: 'token-holding',
        minimumAmount: '100000000000000000000000',
        minimumDurationSeconds: 172_800,
        tokenSymbol: 'EDEN',
      }],
    })).toBe('eligibility requirements apply')
  })

  it('omits eligibility copy when the campaign has no requirements', () => {
    expect(rewardCampaignEligibilityLabel(baseCampaign)).toBeUndefined()
    expect(rewardCampaignEligibilityLabel({ source: 'merkl', eligibilityRequirements: [] })).toBeUndefined()
    expect(rewardCampaignEligibilityLabel({
      source: 'merkl',
      eligibilityRequirementsStatus: 'none',
      eligibilityRequirements: [{ type: 'provider-defined' }],
    })).toBeUndefined()
  })
})

describe('rewardUnclaimedAmount', () => {
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

  const buildReward = (token: Partial<UserReward['token']>, unclaimed = '603375'): UserReward => ({
    chainId: 1,
    token: {
      address: USDC as UserReward['token']['address'],
      chainId: 1,
      symbol: USDC,
      name: USDC,
      ...token,
    },
    tokenPrice: 1,
    provider: 'turtle',
    accumulated: unclaimed,
    unclaimed,
  })

  it('scales the raw amount by the resolved decimals', () => {
    const reward = buildReward({ symbol: 'USDC', name: 'USD Coin', decimals: 6 })
    expect(rewardUnclaimedAmount(reward)).toBe(0.603375)
    expect(rewardUnclaimedUsdValue(reward)).toBe(0.603375)
  })

  it('treats 0 decimals as resolved rather than missing', () => {
    expect(rewardUnclaimedAmount(buildReward({ decimals: 0 }))).toBe(603375)
  })

  it('returns undefined when decimals are unresolved instead of guessing 18', () => {
    const reward = buildReward({})
    expect(reward.token.decimals).toBeUndefined()
    expect(rewardUnclaimedAmount(reward)).toBeUndefined()
    expect(rewardUnclaimedUsdValue(reward)).toBeUndefined()
  })
})
