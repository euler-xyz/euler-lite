import { DateTime } from 'luxon'
import type { RewardCampaign } from '@eulerxyz/euler-v2-sdk'

export type { RewardAction, RewardCampaign, RewardSource } from '@eulerxyz/euler-v2-sdk'

export interface RewardCampaignDisplay {
  id: string
  parityKey: string
  apr: number
  endDate: DateTime | null
  rewardToken: {
    symbol: string
    icon: string
  }
  source: RewardCampaign['source']
  sourceUrl?: string
  isCollateralSpecific: boolean
  minMultiplier?: number
  maxMultiplier?: number
}

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

export const normalizeRewardEndTimestamp = (timestamp?: number): number => {
  if (!timestamp) return 0
  return timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : timestamp
}

export const isRewardCampaignActive = (
  campaign: RewardCampaign,
  now = Math.floor(Date.now() / 1000),
): boolean => {
  const endTimestamp = normalizeRewardEndTimestamp(campaign.endTimestamp)
  return endTimestamp === 0 || endTimestamp > now
}

/**
 * Decide whether `userAddress` is eligible to earn `campaign`.
 *
 * Without a connected wallet we can't tell who the visitor is, so we keep the
 * full "headline" APR visible — discovery surfaces still advertise the upside.
 * Once a wallet (or spy address) is in scope we filter per Merkl semantics:
 *   - non-empty whitelist → eligibility is exactly whitelist membership,
 *     even if the user is also on the blacklist
 *   - otherwise, blacklist membership disqualifies
 */
export const isCampaignEligibleForAddress = (
  campaign: Pick<RewardCampaign, 'whitelist' | 'blacklist'>,
  userAddress: string | undefined | null,
): boolean => {
  if (!userAddress) return true
  const addr = userAddress.toLowerCase()
  if (campaign.whitelist?.length) return campaign.whitelist.includes(addr)
  if (campaign.blacklist?.includes(addr)) return false
  return true
}

export const rewardCampaignAprPercent = (campaign: RewardCampaign): number =>
  campaign.apr * 100

export const rewardCampaignToken = (campaign: RewardCampaign): RewardCampaignDisplay['rewardToken'] => ({
  symbol: campaign.rewardTokenSymbol || 'Unknown',
  icon: campaign.rewardTokenIcon || '',
})

export const rewardCampaignKey = (campaign: RewardCampaign, prefix?: string): string => {
  const parts = [
    prefix,
    campaign.campaignId,
    campaign.source,
    campaign.action,
    campaign.rewardTokenSymbol,
    normalizeRewardEndTimestamp(campaign.endTimestamp),
    campaign.collateralAddress?.toLowerCase(),
  ]
  return parts.filter(Boolean).join('-')
}

export const rewardCampaignParityKey = (campaign: RewardCampaign, vaultAddress?: string): string => {
  if (!vaultAddress) return rewardCampaignKey(campaign)
  return [
    vaultAddress.toLowerCase(),
    campaign.source,
    normalizeRewardEndTimestamp(campaign.endTimestamp),
  ].join('-')
}

export const rewardCampaignDisplay = (
  campaign: RewardCampaign,
  prefix?: string,
  vaultAddress?: string,
): RewardCampaignDisplay => {
  const endTimestamp = normalizeRewardEndTimestamp(campaign.endTimestamp)
  return {
    id: rewardCampaignKey(campaign, prefix),
    parityKey: rewardCampaignParityKey(campaign, vaultAddress),
    apr: rewardCampaignAprPercent(campaign),
    endDate: endTimestamp > 0 ? DateTime.fromSeconds(endTimestamp) : null,
    rewardToken: rewardCampaignToken(campaign),
    source: campaign.source,
    isCollateralSpecific: campaign.action === 'BORROW_COLLATERAL',
    ...(campaign.sourceUrl ? { sourceUrl: campaign.sourceUrl } : {}),
    ...(campaign.minMultiplier !== undefined ? { minMultiplier: campaign.minMultiplier } : {}),
    ...(campaign.maxMultiplier !== undefined ? { maxMultiplier: campaign.maxMultiplier } : {}),
  }
}

export const rewardCampaignDisplays = (
  campaigns: RewardCampaign[] | undefined,
  prefix?: string,
  vaultAddress?: string,
): RewardCampaignDisplay[] => {
  if (!campaigns) return []
  return campaigns
    .filter(campaign => isRewardCampaignActive(campaign))
    .map(campaign => rewardCampaignDisplay(campaign, prefix, vaultAddress))
    .sort((a, b) => a.rewardToken.symbol.localeCompare(b.rewardToken.symbol))
}
