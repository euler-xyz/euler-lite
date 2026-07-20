import type { RewardCampaign, VaultRewardInfo } from '@eulerxyz/euler-v2-sdk'
import { isCampaignEligibleForAddress, rewardCampaignAprPercent } from '~/entities/reward-campaign'

type VaultWithRewards = {
  rewards?: VaultRewardInfo
}

export const useRewardsApy = () => {
  const { settings } = useUserSettings()
  const { enableMerkl, enableIncentra, enableFuul, enableTurtle } = useDeployConfig()
  const { getVault, registryVersion } = useVaultRegistry()
  const { address: connectedAddress } = useWagmi()
  const { spyAddress } = useSpyMode()

  const isEnabled = computed(() => settings.value.enableRewardsApy)

  // Active address for whitelist/blacklist filtering: spy mode wins (we want
  // to see what the spied user actually earns), otherwise the connected
  // wallet. When neither is set the filter is a no-op — discovery surfaces
  // keep the full "headline" APR visible to unconnected visitors.
  const eligibilityAddress = computed(() =>
    spyAddress.value || connectedAddress.value || undefined,
  )

  // Reactive version counter — bumps when any underlying data or settings change.
  // Consumers should read `version.value` in the sync phase of watchEffect(async)
  // to ensure they re-run when reward data updates.
  const _versionCounter = ref(0)
  watch(
    [isEnabled, registryVersion, eligibilityAddress],
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
    if (campaign.source === 'turtle') return enableTurtle
    return false
  }

  const getCampaignsFromRewards = (rewards: VaultRewardInfo | undefined): RewardCampaign[] => {
    if (!isEnabled.value) return []
    const addr = eligibilityAddress.value
    return (rewards?.getActiveCampaigns({ viewer: addr }) ?? [])
      .filter(isCampaignProviderEnabled)
      .filter(c => isCampaignEligibleForAddress(c, addr))
  }

  const getCampaignsForVault = (vaultAddress: string): RewardCampaign[] => {
    return getCampaignsFromRewards(getVaultRewards(vaultAddress))
  }

  const getCampaignsForVaultEntity = (vault: VaultWithRewards | undefined): RewardCampaign[] => {
    return getCampaignsFromRewards(vault?.rewards)
  }

  const isMatchingAnyCollateral = (campaign: RewardCampaign, collateralAddresses: readonly string[]): boolean => {
    const campaignAddress = campaign.collateralAddress?.toLowerCase()
    return Boolean(campaignAddress && collateralAddresses.some(address => address.toLowerCase() === campaignAddress))
  }

  const getSupplyRewardApy = (vaultAddress: string): number => {
    return getSupplyRewardCampaigns(vaultAddress)
      .reduce((sum, c) => sum + rewardCampaignAprPercent(c), 0)
  }

  const getBorrowRewardCampaignsForCollaterals = (
    borrowVaultAddress: string,
    collateralAddresses: readonly string[],
  ): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(borrowVaultAddress).filter((campaign) => {
      if (campaign.action === 'BORROW') return true
      return campaign.action === 'BORROW_COLLATERAL'
        && isMatchingAnyCollateral(campaign, collateralAddresses)
    })
  }

  const getBorrowRewardApyForCollaterals = (borrowVaultAddress: string, collateralAddresses: readonly string[]): number => {
    return getBorrowRewardCampaignsForCollaterals(borrowVaultAddress, collateralAddresses)
      .reduce((sum, campaign) => sum + rewardCampaignAprPercent(campaign), 0)
  }

  const getBorrowRewardApy = (borrowVaultAddress: string, collateralAddress?: string): number =>
    getBorrowRewardApyForCollaterals(borrowVaultAddress, collateralAddress ? [collateralAddress] : [])

  const hasSupplyRewards = (vaultAddress: string): boolean => {
    return getSupplyRewardApy(vaultAddress) > 0
  }

  const getLoopingRewardApyForCollaterals = (borrowVaultAddress: string, collateralAddresses: readonly string[]): number => {
    return getLoopingRewardCampaignsForCollaterals(borrowVaultAddress, collateralAddresses)
      .reduce((sum, campaign) => sum + rewardCampaignAprPercent(campaign), 0)
  }

  const getLoopingRewardApy = (borrowVaultAddress: string, collateralAddress?: string): number =>
    getLoopingRewardApyForCollaterals(borrowVaultAddress, collateralAddress ? [collateralAddress] : [])

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

  const getEligibleLoopingRewardApyForCollaterals = (
    borrowVaultAddress: string,
    collateralAddresses: readonly string[],
    multiplier: number | null | undefined,
  ): number => {
    return getEligibleLoopingRewardCampaignsForCollaterals(borrowVaultAddress, collateralAddresses, multiplier)
      .reduce((sum, campaign) => sum + rewardCampaignAprPercent(campaign), 0)
  }

  const getSupplyRewardCampaigns = (vaultAddress: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(vaultAddress).filter(c => c.action === 'LEND')
  }

  const getSupplyRewardCampaignsFromVault = (vault: VaultWithRewards | undefined): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVaultEntity(vault).filter(c => c.action === 'LEND')
  }

  const getBorrowRewardCampaigns = (borrowVaultAddress: string, collateralAddress?: string): RewardCampaign[] => {
    return getBorrowRewardCampaignsForCollaterals(
      borrowVaultAddress,
      collateralAddress ? [collateralAddress] : [],
    )
  }

  const getLoopingRewardCampaignsForCollaterals = (
    borrowVaultAddress: string,
    collateralAddresses: readonly string[],
  ): RewardCampaign[] => {
    if (!isEnabled.value) return []
    return getCampaignsForVault(borrowVaultAddress).filter(c =>
      c.action === 'LOOPING'
      && isMatchingAnyCollateral(c, collateralAddresses),
    )
  }

  const getLoopingRewardCampaigns = (borrowVaultAddress: string, collateralAddress?: string): RewardCampaign[] => {
    return getLoopingRewardCampaignsForCollaterals(
      borrowVaultAddress,
      collateralAddress ? [collateralAddress] : [],
    )
  }

  const getEligibleLoopingRewardCampaignsForCollaterals = (
    borrowVaultAddress: string,
    collateralAddresses: readonly string[],
    multiplier: number | null | undefined,
  ): RewardCampaign[] => {
    if (multiplier === null || multiplier === undefined || !Number.isFinite(multiplier)) return []
    return getLoopingRewardCampaignsForCollaterals(borrowVaultAddress, collateralAddresses)
      .filter(c => (!c.minMultiplier || multiplier >= c.minMultiplier) && (!c.maxMultiplier || multiplier <= c.maxMultiplier))
  }

  return {
    isEnabled,
    version,
    getSupplyRewardApy,
    getBorrowRewardApy,
    getBorrowRewardApyForCollaterals,
    getBorrowRewardCampaignsForCollaterals,
    getLoopingRewardApy,
    getLoopingRewardApyForCollaterals,
    getEligibleLoopingRewardApy,
    getEligibleLoopingRewardApyForCollaterals,
    hasSupplyRewards,
    hasBorrowRewards,
    hasLoopingRewards,
    isLoopingEligible,
    getSupplyRewardCampaigns,
    getSupplyRewardCampaignsFromVault,
    getBorrowRewardCampaigns,
    getLoopingRewardCampaigns,
    getLoopingRewardCampaignsForCollaterals,
    getEligibleLoopingRewardCampaignsForCollaterals,
  }
}
