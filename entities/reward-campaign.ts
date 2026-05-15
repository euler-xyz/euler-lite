export type RewardCampaignType = 'euler_lend' | 'euler_borrow' | 'euler_borrow_collateral' | 'euler_looping'

export interface RewardCampaign {
  vault: string
  collateral?: string
  type: RewardCampaignType
  apr: number
  provider: 'merkl' | 'brevis' | 'fuul'
  endTimestamp: number
  rewardToken?: {
    symbol: string
    icon: string
  }
  sourceUrl?: string
  minMultiplier?: number
  maxMultiplier?: number
  // Address lists honoured by the campaign distributor, stored lowercase.
  // - `whitelist` (when non-empty): only these recipients earn; it takes
  //   precedence over blacklist.
  // - `blacklist`: these recipients do not earn when there is no whitelist.
  whitelist?: string[]
  blacklist?: string[]
}

/**
 * Decide whether `userAddress` is eligible to earn the campaign.
 *
 * The helper is symmetric in how it handles a missing address:
 *   - A campaign with a non-empty whitelist is an explicit allow-list; an
 *     unidentified visitor is definitionally NOT on it, so they're ineligible.
 *   - A blacklist is an explicit deny-list; an unidentified visitor can't be
 *     on it, so they pass the blacklist check.
 *   - When both are present, whitelist precedence matches Merkl's campaign
 *     semantics: whitelist membership is sufficient for eligibility.
 *
 * Net result: discovery surfaces (no wallet connected) hide whitelisted
 * campaigns from the headline APR — they're not earnable by an arbitrary
 * visitor — but blacklists alone don't suppress anything.
 */
export const isCampaignEligibleForAddress = (
  campaign: Pick<RewardCampaign, 'whitelist' | 'blacklist'>,
  userAddress: string | undefined | null,
): boolean => {
  const addr = userAddress ? userAddress.toLowerCase() : ''
  if (campaign.whitelist?.length) return campaign.whitelist.includes(addr)
  if (addr && campaign.blacklist?.includes(addr)) return false
  return true
}

// Merkl subType is a positional index: 0 = euler_lend, 1 = euler_borrow, 2 = euler_borrow_collateral
const EULER_SUBTYPES: RewardCampaignType[] = ['euler_lend', 'euler_borrow', 'euler_borrow_collateral']

export const mapMerklSubType = (subType: number): RewardCampaignType | null =>
  EULER_SUBTYPES[subType] ?? null

export const PROVIDER_LABELS: Record<string, string> = {
  merkl: 'Merkl',
  brevis: 'Brevis',
  fuul: 'Fuul',
}

export const PROVIDER_LOGOS: Record<string, string> = {
  merkl: '/entities/merkl.png',
  brevis: '/entities/brevis.png',
  fuul: '/entities/fuul.png',
}
