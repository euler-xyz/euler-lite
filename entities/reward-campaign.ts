import { DateTime } from 'luxon'
import type { Address } from 'viem'
import type {
  RewardAction,
  RewardCampaign as SdkRewardCampaign,
  RewardSource as SdkRewardSource,
  UserReward as SdkUserReward,
} from '@eulerxyz/euler-v2-sdk'
import { safeExternalHttpUrl } from '~/utils/external-url'

export type { RewardAction }

export type RewardSource = SdkRewardSource | 'turtle'

export type RewardCampaign = Omit<SdkRewardCampaign, 'source' | 'eligibilityRequirements'> & {
  source: RewardSource
  eligibilityRequirements?: unknown[]
}

export type UserReward = Omit<SdkUserReward, 'provider'> & {
  provider: RewardSource
  streamId?: string
  streamAddress?: Address
  // Matches the SDK's `UserReward.timestamp` (ISO string or Unix seconds), so
  // SDK `userRewards` are assignable without narrowing.
  timestamp?: string | number
}

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
  eligibilityLabel?: string
  isCollateralSpecific: boolean
  minMultiplier?: number
  maxMultiplier?: number
}

export const PROVIDER_LABELS: Record<string, string> = {
  merkl: 'Merkl',
  brevis: 'Incentra',
  fuul: 'Fuul',
  turtle: 'Turtle',
}

export const PROVIDER_LOGOS: Record<string, string> = {
  merkl: '/entities/merkl.png',
  brevis: '/entities/brevis.png',
  fuul: '/entities/fuul.png',
  turtle: '/entities/turtle.png',
}

const TURTLE_DASHBOARD_ORGANIZATION_ID = '52974bc3-2c43-4576-ac18-107d92b6e0c7'

export const PROVIDER_SOURCE_URLS: Partial<Record<RewardCampaign['source'], string>> = {
  brevis: 'https://incentra.brevis.network/',
  fuul: 'https://www.fuul.xyz/',
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

export const rewardCampaignSourceUrl = (campaign: RewardCampaign): string | undefined => {
  // V3/provider data reaches multiple `href` bindings through this chokepoint.
  if (campaign.sourceUrl) return safeExternalHttpUrl(campaign.sourceUrl)
  if (campaign.source === 'merkl') return undefined
  return campaign.source === 'turtle'
    ? `https://dashboard.turtle.xyz/organizations/${TURTLE_DASHBOARD_ORGANIZATION_ID}/incentives/streams/${campaign.campaignId}`
    : PROVIDER_SOURCE_URLS[campaign.source]
}

export const rewardCampaignEligibilityLabel = (
  campaign: Pick<RewardCampaign, 'source' | 'eligibilityRequirements'>,
  hasProviderDetailsUrl = false,
): string | undefined => campaign.eligibilityRequirements?.length
  ? hasProviderDetailsUrl
    ? `eligibility requirements apply; see ${PROVIDER_LABELS[campaign.source] || campaign.source} for details`
    : 'eligibility requirements apply'
  : undefined

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
  const sourceUrl = rewardCampaignSourceUrl(campaign)
  const eligibilityLabel = rewardCampaignEligibilityLabel(campaign, Boolean(sourceUrl))
  return {
    id: rewardCampaignKey(campaign, prefix),
    parityKey: rewardCampaignParityKey(campaign, vaultAddress),
    apr: rewardCampaignAprPercent(campaign),
    endDate: endTimestamp > 0 ? DateTime.fromSeconds(endTimestamp) : null,
    rewardToken: rewardCampaignToken(campaign),
    source: campaign.source,
    isCollateralSpecific: campaign.action === 'BORROW_COLLATERAL',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(eligibilityLabel ? { eligibilityLabel } : {}),
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
