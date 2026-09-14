import type { YieldApyBreakdown } from '@eulerxyz/euler-v2-sdk'
import type { RewardCampaign, RewardAction, RewardSource } from '~/entities/reward-campaign'
import { rewardCampaignDisplay, rewardCampaignKey } from '~/entities/reward-campaign'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'
import { formatNumber } from '~/utils/string-utils'

export type ProjectedYieldMetric = 'net-apy' | 'roe' | 'supply-apy'

export interface ProjectedYieldInputs {
  supplyUsd: number
  baseSupplyApy: number
  intrinsicSupplyApy?: number | null
  supplyRewardApy?: number | null
  borrowUsd: number
  baseBorrowApy: number
  intrinsicBorrowApy?: number | null
  borrowRewardApy?: number | null
  loopingRewardApy?: number | null
}

export interface ProjectedYieldState {
  total: number
  breakdown: YieldApyBreakdown
}

export interface ProjectedYieldRateLine {
  id: string
  label: string
  symbol?: string
  vaultAddress?: string
  before?: number | null
  after?: number | null
}

export interface ProjectedYieldCampaignInput {
  campaign: RewardCampaign
  vaultAddress?: string
}

export interface ProjectedYieldRewardLine {
  id: string
  action: RewardAction
  vaultAddress?: string
  collateralAddress?: string
  rewardToken: {
    symbol: string
    icon: string
  }
  source: RewardSource
  sourceUrl?: string
  eligibilityLabel?: string
  beforeApr?: number | null
  afterApr?: number | null
}

export interface ProjectedRewardAprPresentation {
  before?: string
  after: string
}

export interface ProjectedYieldDetails {
  metric: ProjectedYieldMetric
  before?: ProjectedYieldState | null
  after: ProjectedYieldState
  rateLines: ProjectedYieldRateLine[]
  rewards: ProjectedYieldRewardLine[]
}

/**
 * Format a projected campaign row without treating an inapplicable current
 * campaign as a negative-looking dash. A numeric zero remains a real current
 * APR, while a campaign that no longer applies keeps its transition to "-".
 */
export const getProjectedRewardAprPresentation = (
  before: number | null | undefined,
  after: number | null | undefined,
): ProjectedRewardAprPresentation => {
  const display = (value: number | null | undefined) =>
    value == null ? '-' : `${formatNumber(value)}%`
  const beforeDisplay = display(before)
  const afterDisplay = display(after)

  if (before != null && (after == null || beforeDisplay !== afterDisplay)) {
    return { before: beforeDisplay, after: afterDisplay }
  }

  return { after: afterDisplay }
}

const zeroBreakdown = (): YieldApyBreakdown => ({
  lending: 0,
  borrowing: 0,
  rewards: 0,
  intrinsicApy: 0,
  total: 0,
})

/**
 * Build the same yield numerator used by the form headline while retaining its
 * individual contributions for the projected-yield preview.
 */
export const getProjectedYieldState = (
  metric: ProjectedYieldMetric,
  inputs: ProjectedYieldInputs,
): ProjectedYieldState | null => {
  const values = [
    inputs.supplyUsd,
    inputs.baseSupplyApy,
    inputs.borrowUsd,
    inputs.baseBorrowApy,
    inputs.intrinsicSupplyApy ?? 0,
    inputs.supplyRewardApy ?? 0,
    inputs.intrinsicBorrowApy ?? 0,
    inputs.borrowRewardApy ?? 0,
    inputs.loopingRewardApy ?? 0,
  ]
  if (values.some(value => !Number.isFinite(value))) return null

  const equity = inputs.supplyUsd - inputs.borrowUsd
  const denominator = metric === 'roe' ? equity : inputs.supplyUsd
  if (denominator <= 0) {
    return { total: 0, breakdown: zeroBreakdown() }
  }

  const lending = inputs.supplyUsd * inputs.baseSupplyApy / denominator
  const borrowing = -inputs.borrowUsd * inputs.baseBorrowApy / denominator
  const intrinsicApy = (
    inputs.supplyUsd * (inputs.intrinsicSupplyApy ?? 0)
    - inputs.borrowUsd * (inputs.intrinsicBorrowApy ?? 0)
  ) / denominator
  const rewards = (
    inputs.supplyUsd * (inputs.supplyRewardApy ?? 0)
    + inputs.borrowUsd * (inputs.borrowRewardApy ?? 0)
    + equity * (inputs.loopingRewardApy ?? 0)
  ) / denominator
  const total = lending + borrowing + intrinsicApy + rewards

  if (![lending, borrowing, intrinsicApy, rewards, total].every(Number.isFinite)) return null
  return {
    total,
    breakdown: { lending, borrowing, rewards, intrinsicApy, total },
  }
}

export interface ProjectedDebtYieldInputs {
  borrowUsd: number
  baseBorrowApy: number
  borrowApyWithIntrinsic: number
  borrowRewardApy?: number | null
  loopingRewardApy?: number | null
}

export const getProjectedYieldStateFromCollateralSnapshot = (
  metric: ProjectedYieldMetric,
  snapshot: CollateralApySnapshot,
  debt: ProjectedDebtYieldInputs,
): ProjectedYieldState | null => {
  if (!snapshot.isComplete) return null
  return getProjectedYieldState(metric, {
    supplyUsd: snapshot.supplyUsd,
    baseSupplyApy: snapshot.weightedBaseSupplyApy ?? snapshot.weightedSupplyApy ?? 0,
    intrinsicSupplyApy: snapshot.weightedIntrinsicSupplyApy ?? 0,
    supplyRewardApy: snapshot.weightedSupplyRewardApy ?? 0,
    borrowUsd: debt.borrowUsd,
    baseBorrowApy: debt.baseBorrowApy,
    intrinsicBorrowApy: debt.borrowApyWithIntrinsic - debt.baseBorrowApy,
    borrowRewardApy: debt.borrowRewardApy,
    loopingRewardApy: debt.loopingRewardApy,
  })
}

export const getCollateralSnapshotCampaignInputs = (
  snapshot: CollateralApySnapshot,
): ProjectedYieldCampaignInput[] => snapshot.entries
  .filter(entry => entry.supplyUsd > 0)
  .flatMap(entry => entry.supplyCampaigns.map(campaign => ({
    campaign,
    vaultAddress: entry.address,
  })))

export const getCollateralSnapshotRateLines = (
  before: CollateralApySnapshot | null | undefined,
  after: CollateralApySnapshot,
): ProjectedYieldRateLine[] => {
  const entriesByAddress = new Map<string, {
    before?: number
    after?: number
    symbol?: string
  }>()
  before?.entries.forEach((entry) => {
    entriesByAddress.set(entry.address.toLowerCase(), {
      before: entry.baseSupplyApy,
      symbol: entry.vault.asset.symbol,
    })
  })
  after.entries.forEach((entry) => {
    const key = entry.address.toLowerCase()
    entriesByAddress.set(key, {
      ...entriesByAddress.get(key),
      after: entry.baseSupplyApy,
      symbol: entry.vault.asset.symbol,
    })
  })
  return [...entriesByAddress.entries()]
    .filter(([, rates]) => rates.before !== rates.after)
    .map(([address, rates]) => ({
      id: `supply:${address}`,
      label: 'Collateral lending APY',
      symbol: rates.symbol,
      vaultAddress: address,
      before: rates.before,
      after: rates.after,
    }))
}

const campaignLineKey = ({ campaign, vaultAddress }: ProjectedYieldCampaignInput) =>
  [vaultAddress?.toLowerCase(), rewardCampaignKey(campaign)].filter(Boolean).join(':')

/** Preserve reward-token identity while comparing eligibility before/after. */
export const mergeProjectedRewardCampaigns = (
  before: readonly ProjectedYieldCampaignInput[] = [],
  after: readonly ProjectedYieldCampaignInput[] = [],
): ProjectedYieldRewardLine[] => {
  const lines = new Map<string, ProjectedYieldRewardLine>()

  const add = (input: ProjectedYieldCampaignInput, side: 'beforeApr' | 'afterApr') => {
    const id = campaignLineKey(input)
    const display = rewardCampaignDisplay(input.campaign, undefined, input.vaultAddress)
    const current = lines.get(id)
    const line: ProjectedYieldRewardLine = {
      ...current,
      id,
      action: input.campaign.action,
      ...(input.vaultAddress ? { vaultAddress: input.vaultAddress } : {}),
      ...(input.campaign.collateralAddress
        ? { collateralAddress: input.campaign.collateralAddress }
        : {}),
      rewardToken: display.rewardToken,
      source: display.source,
      ...(display.sourceUrl ? { sourceUrl: display.sourceUrl } : {}),
      ...(display.eligibilityLabel ? { eligibilityLabel: display.eligibilityLabel } : {}),
      [side]: display.apr,
    }

    if (!display.sourceUrl) delete line.sourceUrl
    if (!display.eligibilityLabel) delete line.eligibilityLabel

    lines.set(id, line)
  }

  before.forEach(input => add(input, 'beforeApr'))
  after.forEach(input => add(input, 'afterApr'))

  return [...lines.values()].sort((a, b) =>
    a.rewardToken.symbol.localeCompare(b.rewardToken.symbol)
    || a.action.localeCompare(b.action)
    || (a.collateralAddress ?? '').localeCompare(b.collateralAddress ?? '')
    || (a.vaultAddress ?? '').localeCompare(b.vaultAddress ?? ''),
  )
}

export const projectedYieldHasRewards = (details: ProjectedYieldDetails | null | undefined): boolean =>
  Boolean(details && (
    Math.abs(details.before?.breakdown.rewards ?? 0) > 0
    || Math.abs(details.after.breakdown.rewards) > 0
    || details.rewards.some(reward => (reward.beforeApr ?? 0) > 0 || (reward.afterApr ?? 0) > 0)
  ))
