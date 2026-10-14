import { isEulerEarn } from '@eulerxyz/euler-v2-sdk'
import { toValue, type MaybeRefOrGetter } from 'vue'
import { formatCompactUsdValue } from '~/utils/string-utils'
import { getCollateralBorrowsUsd, getStrategyDepositShare, type VaultCheckSubject } from '~/utils/vault-assessment/subjects'

export const formatDepositShare = (share: number): string => {
  const percent = share * 100
  if (percent > 0 && percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

export const useVaultCheckWeights = (vaultAddress: MaybeRefOrGetter<string>) => {
  const { get, registryVersion } = useVaultRegistry()
  const { load, isLoaded, getOpenInterestForVault } = useCollateralOpenInterest()
  void load()

  const weightOf = (subject: VaultCheckSubject | undefined): string | null => {
    if (!subject) return null
    void registryVersion.value
    const vault = get(toValue(vaultAddress))?.vault
    const earn = vault && isEulerEarn(vault) ? vault : null
    if (subject.namespace === 'strategy') {
      const share = earn ? getStrategyDepositShare(earn, subject.address) : undefined
      if (share === undefined) return null
      return share === 0 ? 'Holds none of the deposits' : `Holds ${formatDepositShare(share)} of deposits`
    }
    if (!isLoaded.value) return null
    const sources = earn
      ? earn.strategies.map(strategy => getOpenInterestForVault(strategy.address))
      : [getOpenInterestForVault(toValue(vaultAddress))]
    const usd = getCollateralBorrowsUsd(sources, subject.address)
    const scope = earn ? ' in this vault\'s strategies' : ''
    return usd > 0 ? `Backs ${formatCompactUsdValue(usd)} of borrows${scope}` : `Backs no borrows${scope}`
  }

  return { weightOf }
}
