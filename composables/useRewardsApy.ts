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

  const isMatchingCollateral = (campaign: RewardCampaign, collateralAddress?: string): boolean =>
    Boolean(
      collateralAddress
      && campaign.collateralAddress?.toLowerCase() === collateralAddress.toLowerCase(),
    )

  const isMatchingAnyCollateral = (campaign: RewardCampaign, collateralAddresses: readonly string[]): boolean => {
    const campaignAddress = campaign.collateralAddress?.toLowerCase()
    return Boolean(campaignAddress && collateralAddresses.some(address => address.toLowerCase() === campaignAddress))
  }

  const getSupplyRewardApy = (vaultAddress: string): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(vaultAddress)
    return campaigns
      .filter(c => c.action === 'LEND')
      .reduce((sum, c) => sum + rewardCampaignAprPercent(c), 0)
  }

  const getBorrowRewardApyForCollaterals = (borrowVaultAddress: string, collateralAddresses: readonly string[]): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(borrowVaultAddress)

    let total = 0
    for (const c of campaigns) {
      if (c.action === 'BORROW') {
        total += rewardCampaignAprPercent(c)
      }
      else if (
        c.action === 'BORROW_COLLATERAL'
        && isMatchingAnyCollateral(c, collateralAddresses)
      ) {
        total += rewardCampaignAprPercent(c)
      }
    }
    return total
  }

  const getBorrowRewardApy = (borrowVaultAddress: string, collateralAddress?: string): number =>
    getBorrowRewardApyForCollaterals(borrowVaultAddress, collateralAddress ? [collateralAddress] : [])

  const hasSupplyRewards = (vaultAddress: string): boolean => {
    return getSupplyRewardApy(vaultAddress) > 0
  }

  const getLoopingRewardApyForCollaterals = (borrowVaultAddress: string, collateralAddresses: readonly string[]): number => {
    if (!isEnabled.value) return 0
    const campaigns = getCampaignsForVault(borrowVaultAddress)
    let total = 0
    for (const c of campaigns) {
      if (
        c.action === 'LOOPING'
        && isMatchingAnyCollateral(c, collateralAddresses)
      ) {
        total += rewardCampaignAprPercent(c)
      }
    }
    return total
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
    if (!isEnabled.value || multiplier === null || multiplier === undefined || !Number.isFinite(multiplier)) return 0
    return getCampaignsForVault(borrowVaultAddress)
      .filter(c => c.action === 'LOOPING' && isMatchingAnyCollateral(c, collateralAddresses))
      .filter(c => (!c.minMultiplier || multiplier >= c.minMultiplier) && (!c.maxMultiplier || multiplier <= c.maxMultiplier))
      .reduce((sum, c) => sum + rewardCampaignAprPercent(c), 0)
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
    getBorrowRewardApyForCollaterals,
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
  }
}
