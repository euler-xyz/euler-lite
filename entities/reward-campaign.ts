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
}

// Merkl subType is a positional index: 0 = euler_lend, 1 = euler_borrow, 2 = euler_borrow_collateral
const EULER_SUBTYPES: RewardCampaignType[] = ['euler_lend', 'euler_borrow', 'euler_borrow_collateral']

export const mapMerklSubType = (subType: number): RewardCampaignType | null =>
  EULER_SUBTYPES[subType] ?? null

export const PROVIDER_LABELS: Record<string, string> = {
  merkl: 'Merkl',
  brevis: 'Incentra',
  fuul: 'Fuul',
}

export const PROVIDER_LOGOS: Record<string, string> = {
  merkl: '/entities/merkl.png',
  brevis: '/entities/brevis.png',
  fuul: '/entities/fuul.png',
}
