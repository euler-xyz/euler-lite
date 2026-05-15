import { describe, expect, it } from 'vitest'
import { isCampaignEligibleForAddress, type RewardCampaign } from '~/entities/reward-campaign'

const USER = '0xAaAa00000000000000000000000000000000aAaA'
const OTHER = '0xBbBb00000000000000000000000000000000bBbB'

const makeCampaign = (overrides: Partial<RewardCampaign> = {}): RewardCampaign => ({
  vault: '0xvault',
  type: 'euler_lend',
  apr: 1,
  provider: 'merkl',
  endTimestamp: 0,
  ...overrides,
})

describe('isCampaignEligibleForAddress', () => {
  it('passes a plain campaign for a connected wallet', () => {
    expect(isCampaignEligibleForAddress(makeCampaign(), USER)).toBe(true)
  })

  it('passes a plain campaign for an unidentified visitor', () => {
    expect(isCampaignEligibleForAddress(makeCampaign(), undefined)).toBe(true)
    expect(isCampaignEligibleForAddress(makeCampaign(), null)).toBe(true)
    expect(isCampaignEligibleForAddress(makeCampaign(), '')).toBe(true)
  })

  it('admits an address on the whitelist (case-insensitive)', () => {
    const c = makeCampaign({ whitelist: [USER.toLowerCase()] })
    expect(isCampaignEligibleForAddress(c, USER)).toBe(true)
  })

  it('rejects an address absent from the whitelist', () => {
    const c = makeCampaign({ whitelist: [OTHER.toLowerCase()] })
    expect(isCampaignEligibleForAddress(c, USER)).toBe(false)
  })

  it('passes an unidentified visitor unconditionally', () => {
    const whitelistOnly = makeCampaign({ whitelist: [USER.toLowerCase()] })
    const blacklistOnly = makeCampaign({ blacklist: [USER.toLowerCase()] })
    for (const addr of [undefined, null, '']) {
      expect(isCampaignEligibleForAddress(whitelistOnly, addr)).toBe(true)
      expect(isCampaignEligibleForAddress(blacklistOnly, addr)).toBe(true)
    }
  })

  it('treats an empty whitelist as "no restriction"', () => {
    const c = makeCampaign({ whitelist: [] })
    expect(isCampaignEligibleForAddress(c, USER)).toBe(true)
    expect(isCampaignEligibleForAddress(c, undefined)).toBe(true)
  })

  it('rejects an address on the blacklist (case-insensitive)', () => {
    const c = makeCampaign({ blacklist: [USER.toLowerCase()] })
    expect(isCampaignEligibleForAddress(c, USER)).toBe(false)
  })

  it('blacklist takes precedence over whitelist', () => {
    const c = makeCampaign({
      whitelist: [USER.toLowerCase()],
      blacklist: [USER.toLowerCase()],
    })
    expect(isCampaignEligibleForAddress(c, USER)).toBe(false)
  })
})
