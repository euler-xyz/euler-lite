import { useAccount } from '@wagmi/vue'
import { isCampaignEligibleForAddress, type RewardCampaign } from '~/entities/reward-campaign'

export const useRewardsApy = () => {
  const { settings } = useUserSettings()
  const { enableMerkl, enableIncentra, enableFuul } = useDeployConfig()
  const { merklCampaigns, getMerklCampaignsForVault } = useMerkl()
  const { brevisCampaigns, getBrevisCampaignsForVault } = useBrevis()
  const { fuulCampaigns, getFuulCampaignsForVault } = useFuul()
  const { address: connectedAddress } = useAccount()
  const { spyAddress } = useSpyMode()

  const isEnabled = computed(() => settings.value.enableRewardsApy)

  // Active address for whitelist/blacklist filtering: spy mode wins (we want
  // to see what the spied user actually earns), otherwise the connected
  // wallet. When neither is set, whitelisted campaigns still get filtered out
  // — an unidentified visitor is definitionally not on any whitelist, so
  // crediting their APR with whitelist-only campaigns would be misleading.
  const eligibilityAddress = computed(() =>
    spyAddress.value || connectedAddress.value || undefined,
  )

  // Reactive version counter — bumps when any underlying data or settings change.
  // Consumers should read `version.value` in the sync phase of watchEffect(async)
  // to ensure they re-run when reward data updates.
  const _versionCounter = ref(0)
  watch(
    [isEnabled, merklCampaigns, brevisCampaigns, fuulCampaigns, eligibilityAddress],
    () => { _versionCounter.value++ },
  )
  const version = computed(() => _versionCounter.value)

  const getCampaignsForVault = (vaultAddress: string): RewardCampaign[] => {
    if (!isEnabled.value) return []
    const addr = eligibilityAddress.value
    return [
      ...(enableMerkl ? getMerklCampaignsForVault(vaultAddress) : []),
      ...(enableIncentra ? getBrevisCampaignsForVault(vaultAddress) : []),
      ...(enableFuul ? getFuulCampaignsForVault(vaultAddress) : []),
    ].filter(c => isCampaignEligibleForAddress(c, addr))
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
