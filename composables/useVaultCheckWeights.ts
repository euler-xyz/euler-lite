import { isEulerEarn, isEVault, type EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { toValue, type MaybeRefOrGetter } from 'vue'
import type { AnyVault } from '~/composables/useVaultRegistry'
import { formatCompactUsdValue } from '~/utils/string-utils'
import { getCollateralBorrowsUsd, getStrategyDepositShare, type VaultCheckSubject } from '~/utils/vault-assessment/subjects'

export const formatDepositShare = (share: number): string => {
  const percent = share * 100
  if (percent > 0 && percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

export interface VaultCheckWeight {
  label: string
  /** Appended where nothing else says the borrows are this Earn vault's strategies'. */
  scope: string
  value: number
}

export const useVaultCheckWeights = (vaultAddress: MaybeRefOrGetter<string>) => {
  const { get, registryVersion } = useVaultRegistry()
  const { load, isLoaded, getOpenInterestForVault } = useCollateralOpenInterest()
  void load()

  const readBorrowSources = (vault: AnyVault | undefined, earn: EulerEarn | null): Record<string, number>[] | null => {
    const borrowVaults = earn
      ? earn.strategies.map(strategy => ({ address: strategy.address, vault: strategy.vault ?? get(strategy.address)?.vault }))
      : [{ address: toValue(vaultAddress), vault }]
    const sources = borrowVaults.map(source => getOpenInterestForVault(source.address))
    const hasMissingSplit = borrowVaults.some((source, index) => {
      const hasSplit = Object.values(sources[index]!).some(usd => Number.isFinite(usd) && usd > 0)
      const hasNoBorrows = source.vault && isEVault(source.vault) && source.vault.totalBorrowed === 0n
      return !hasSplit && !hasNoBorrows
    })
    return hasMissingSplit ? null : sources
  }

  /** Open interest is scanned once per call, not once per subject. */
  const weighAll = (subjects: readonly (VaultCheckSubject | undefined)[]): (VaultCheckWeight | null)[] => {
    void registryVersion.value
    const vault = get(toValue(vaultAddress))?.vault
    const earn = vault && isEulerEarn(vault) ? vault : null
    let borrowSources: Record<string, number>[] | null | undefined
    return subjects.map((subject) => {
      if (!subject) return null
      if (subject.namespace === 'strategy') {
        const share = earn ? getStrategyDepositShare(earn, subject.address) : undefined
        if (share === undefined) return null
        return { value: share, scope: '', label: share === 0 ? 'Holds none of the deposits' : `Holds ${formatDepositShare(share)} of deposits` }
      }
      if (!isLoaded.value) return null
      if (borrowSources === undefined) borrowSources = readBorrowSources(vault, earn)
      if (!borrowSources) return null
      const usd = getCollateralBorrowsUsd(borrowSources, subject.address)
      const scope = earn ? ' in this vault\'s strategies' : ''
      return { value: usd, scope, label: usd > 0 ? `Backs ${formatCompactUsdValue(usd)} of borrows` : 'Backs no borrows' }
    })
  }

  const weightOf = (subject: VaultCheckSubject | undefined): string | null => {
    const weight = weighAll([subject])[0]
    return weight ? `${weight.label}${weight.scope}` : null
  }

  return { weightOf, weighAll }
}
