import type { RewardCampaign } from '~/entities/reward-campaign'
import type { RewardCampaign as SdkRewardCampaign, VaultRewardInfo } from '@eulerxyz/euler-v2-sdk'

export const useRewardsApy = () => {
  const { settings } = useUserSettings()
  const { enableMerkl, enableIncentra, enableFuul } = useDeployConfig()
  const { getVault, registryVersion } = useVaultRegistry()

  const isEnabled = computed(() => settings.value.enableRewardsApy)

  // Reactive version counter — bumps when any underlying data or settings change.
  // Consumers should read `version.value` in the sync phase of watchEffect(async)
  // to ensure they re-run when reward data updates.
  const _versionCounter = ref(0)
  watch(
    [isEnabled, registryVersion],
    () => { _versionCounter.value++ },
  )
  const version = computed(() => _versionCounter.value)

  const getVaultRewards = (vaultAddress: string): VaultRewardInfo | undefined => {
    const vault = getVault(vaultAddress) as { rewards?: VaultRewardInfo } | undefined
    return vault?.rewards
  }

  const isCampaignProviderEnabled = (campaign: SdkRewardCampaign): boolean => {
    if (campaign.source === 'merkl') return enableMerkl
    if (campaign.source === 'brevis') return enableIncentra
    if (campaign.source === 'fuul') return enableFuul
    return false
  }

  const normalizeEndTimestamp = (timestamp?: number): number => {
    if (!timestamp) return 0
    return timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : timestamp
  }

  const toRewardCampaign = (vaultAddress: string, campaign: SdkRewardCampaign): RewardCampaign | null => {
    if (!isCampaignProviderEnabled(campaign)) return null
    const type = campaign.action === 'LEND'
      ? 'euler_lend'
      : campaign.action === 'BORROW'
        ? 'euler_borrow'
        : null
    if (!type) return null

    return {
      vault: vaultAddress.toLowerCase(),
      type,
      apr: campaign.apr * 100,
      provider: campaign.source,
      endTimestamp: normalizeEndTimestamp(campaign.endTimestamp),
      rewardToken: campaign.rewardTokenSymbol
        ? { symbol: campaign.rewardTokenSymbol, icon: '' }
        : undefined,
    }
  }

  const getCampaignsForVault = (vaultAddress: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return (getVaultRewards(vaultAddress)?.campaigns ?? [])
      .map(campaign => toRewardCampaign(vaultAddress, campaign))
      .filter((campaign): campaign is RewardCampaign => campaign !== null)
  }

  const getSupplyRewardApy = (vaultAddress: string): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(vaultAddress)
    return campaigns
      .filter(c => c.type === 'euler_lend')
      .reduce((sum, c) => sum + c.apr, 0)
  }

  const getBorrowRewardApy = (borrowVaultAddress: string, collateralAddress?: string): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(borrowVaultAddress)

    let total = 0
    for (const c of campaigns) {
      if (c.type === 'euler_borrow') {
        total += c.apr
      }
      else if (
        c.type === 'euler_borrow_collateral'
        && collateralAddress
        && c.collateral === collateralAddress.toLowerCase()
      ) {
        total += c.apr
      }
    }
    return total
  }

  const hasSupplyRewards = (vaultAddress: string): boolean => {
    return getSupplyRewardApy(vaultAddress) > 0
  }

  const getLoopingRewardApy = (borrowVaultAddress: string, collateralAddress?: string): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(borrowVaultAddress)
    let total = 0
    for (const c of campaigns) {
      if (
        c.type === 'euler_looping'
        && collateralAddress
        && c.collateral === collateralAddress.toLowerCase()
      ) {
        total += c.apr
      }
    }
    return total
  }

  const hasBorrowRewards = (borrowVaultAddress: string, collateralAddress?: string): boolean => {
    return getBorrowRewardApy(borrowVaultAddress, collateralAddress) > 0
  }

  const hasLoopingRewards = (borrowVaultAddress: string, collateralAddress?: string): boolean => {
    return getLoopingRewardApy(borrowVaultAddress, collateralAddress) > 0
  }

  const isLoopingEligible = (borrowVaultAddress: string, collateralAddress: string, multiplier: number): boolean => {
    const campaigns = getLoopingRewardCampaigns(borrowVaultAddress, collateralAddress)
    if (campaigns.length === 0) return false
    return campaigns.every((c) => {
      if (c.minMultiplier && multiplier < c.minMultiplier) return false
      if (c.maxMultiplier && multiplier > c.maxMultiplier) return false
      return true
    })
  }

  const getEligibleLoopingRewardApy = (borrowVaultAddress: string, collateralAddress: string, multiplier: number): number => {
    if (!isEnabled.value) return 0
    if (!isLoopingEligible(borrowVaultAddress, collateralAddress, multiplier)) return 0
    return getLoopingRewardApy(borrowVaultAddress, collateralAddress)
  }

  const getSupplyRewardCampaigns = (vaultAddress: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(vaultAddress).filter(c => c.type === 'euler_lend')
  }

  const getBorrowRewardCampaigns = (borrowVaultAddress: string, collateralAddress?: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(borrowVaultAddress).filter((c) => {
      if (c.type === 'euler_borrow') return true
      if (
        c.type === 'euler_borrow_collateral'
        && collateralAddress
        && c.collateral === collateralAddress.toLowerCase()
      ) return true
      return false
    })
  }

  const getLoopingRewardCampaigns = (borrowVaultAddress: string, collateralAddress?: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(borrowVaultAddress).filter(c =>
      c.type === 'euler_looping'
      && collateralAddress
      && c.collateral === collateralAddress.toLowerCase(),
    )
  }

  return {
    isEnabled,
    version,
    getSupplyRewardApy,
    getBorrowRewardApy,
    getLoopingRewardApy,
    getEligibleLoopingRewardApy,
    hasSupplyRewards,
    hasBorrowRewards,
    hasLoopingRewards,
    isLoopingEligible,
    getSupplyRewardCampaigns,
    getBorrowRewardCampaigns,
    getLoopingRewardCampaigns,
  }
}
