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
  // - `whitelist` (when non-empty): only these recipients earn.
  // - `blacklist`: these recipients never earn.
  whitelist?: string[]
  blacklist?: string[]
}

/**
 * Decide whether `userAddress` is eligible to earn the campaign.
 *
 * Without a connected wallet we can't tell who the visitor is, so we keep the
 * full "headline" APR visible — discovery surfaces still advertise the
 * upside. Once a wallet (or spy address) is in scope we filter strictly:
 *   - non-empty whitelist + user not on it → ineligible
 *   - user on the blacklist → ineligible
 */
export const isCampaignEligibleForAddress = (
  campaign: Pick<RewardCampaign, 'whitelist' | 'blacklist'>,
  userAddress: string | undefined | null,
): boolean => {
  if (!userAddress) return true
  const addr = userAddress.toLowerCase()
  if (campaign.whitelist?.length && !campaign.whitelist.includes(addr)) return false
  if (campaign.blacklist?.includes(addr)) return false
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
