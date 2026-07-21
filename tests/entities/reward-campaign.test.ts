import { describe, expect, it } from 'vitest'
import { isCampaignEligibleForAddress, rewardCampaignDisplay } from '~/entities/reward-campaign'
import type { RewardCampaign } from '~/entities/reward-campaign'

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

  it('links Turtle campaigns to the Turtle stream dashboard', () => {
    expect(rewardCampaignDisplay({
      ...baseCampaign,
      campaignId: '557af9e9-88e8-4233-95e1-630b8b37b613',
      source: 'turtle',
    }).sourceUrl).toBe('https://dashboard.turtle.xyz/organizations/52974bc3-2c43-4576-ac18-107d92b6e0c7/incentives/streams/557af9e9-88e8-4233-95e1-630b8b37b613')
  })
})
