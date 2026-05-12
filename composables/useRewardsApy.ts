import type { RewardCampaign, VaultRewardInfo } from '@eulerxyz/euler-v2-sdk'
import { rewardCampaignAprPercent } from '~/entities/reward-campaign'

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

  const isCampaignProviderEnabled = (campaign: RewardCampaign): boolean => {
    if (campaign.source === 'merkl') return enableMerkl
    if (campaign.source === 'brevis') return enableIncentra
    if (campaign.source === 'fuul') return enableFuul
    return false
  }

  const getCampaignsForVault = (vaultAddress: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return (getVaultRewards(vaultAddress)?.campaigns ?? [])
      .filter(isCampaignProviderEnabled)
  }

  const isMatchingCollateral = (campaign: RewardCampaign, collateralAddress?: string): boolean =>
    Boolean(
      collateralAddress
      && campaign.collateralAddress?.toLowerCase() === collateralAddress.toLowerCase(),
    )

  const getSupplyRewardApy = (vaultAddress: string): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(vaultAddress)
    return campaigns
      .filter(c => c.action === 'LEND')
      .reduce((sum, c) => sum + rewardCampaignAprPercent(c), 0)
  }

  const getBorrowRewardApy = (borrowVaultAddress: string, collateralAddress?: string): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(borrowVaultAddress)

    let total = 0
    for (const c of campaigns) {
      if (c.action === 'BORROW') {
        total += rewardCampaignAprPercent(c)
      }
      else if (
        c.action === 'BORROW_COLLATERAL'
        && isMatchingCollateral(c, collateralAddress)
      ) {
        total += rewardCampaignAprPercent(c)
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
        c.action === 'LOOPING'
        && isMatchingCollateral(c, collateralAddress)
      ) {
        total += rewardCampaignAprPercent(c)
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
    return getCampaignsForVault(vaultAddress).filter(c => c.action === 'LEND')
  }

  const getBorrowRewardCampaigns = (borrowVaultAddress: string, collateralAddress?: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(borrowVaultAddress).filter((c) => {
      if (c.action === 'BORROW') return true
      if (
        c.action === 'BORROW_COLLATERAL'
        && isMatchingCollateral(c, collateralAddress)
      ) return true
      return false
    })
  }

  const getLoopingRewardCampaigns = (borrowVaultAddress: string, collateralAddress?: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(borrowVaultAddress).filter(c =>
      c.action === 'LOOPING'
      && isMatchingCollateral(c, collateralAddress),
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
