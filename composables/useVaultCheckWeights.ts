import { isEulerEarn, isEVault, type EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { toValue, type MaybeRefOrGetter } from 'vue'
import type { AnyVault } from '~/composables/useVaultRegistry'
import { formatCompactUsdValue } from '~/utils/string-utils'
import { getCollateralBorrowsUsd, getStrategyDepositShare, type VaultCheckSubject } from '~/utils/vault-assessment/subjects'
import { sumOpenInterestUsd } from '~/utils/vault/collateral-exposure'
import { getUncoveredBadDebtUsd } from '~/utils/vault/exposure-display'

export const formatDepositShare = (share: number): string => {
  const percent = share * 100
  if (percent > 0 && percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

/** Open interest by collateral is the debt each collateral's current value covers, not the debt borrowed against it. */
export const formatCoveredBorrows = (usd: number): string =>
  usd > 0 ? `Covers ${formatCompactUsdValue(usd)} of borrows` : 'Covers no borrows'

export interface VaultUncoveredBorrows {
  usd: number
  unpricedUsd: number
  scope: string
}

export const formatUncoveredBorrows = ({ usd, unpricedUsd, scope }: VaultUncoveredBorrows): string => {
  const line = `Uncovered: ${formatCompactUsdValue(usd)} of borrows${scope} are not covered by any collateral's current value`
  if (!(unpricedUsd > 0)) return line
  const part = unpricedUsd >= usd - 0.005 ? 'all' : formatCompactUsdValue(unpricedUsd)
  return `${line}; ${part} of it against collateral without a usable price`
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
  const { getVaultBadDebt, isBadDebtEnabled, loadBadDebtForChain } = useVaultBadDebt()
  if (isBadDebtEnabled.value) void loadBadDebtForChain()

  const getBorrowVaults = (vault: AnyVault | undefined, earn: EulerEarn | null) => earn
    ? earn.strategies.map(strategy => ({ address: strategy.address, vault: strategy.vault ?? get(strategy.address)?.vault }))
    : [{ address: toValue(vaultAddress), vault }]

  const readBorrowSources = (vault: AnyVault | undefined, earn: EulerEarn | null): Record<string, number>[] | null => {
    const borrowVaults = getBorrowVaults(vault, earn)
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
      return { value: usd, scope, label: formatCoveredBorrows(usd) }
    })
  }

  const weightOf = (subject: VaultCheckSubject | undefined): string | null => {
    const weight = weighAll([subject])[0]
    return weight ? `${weight.label}${weight.scope}` : null
  }

  /** Bad debt the exposure display would show; covered value then cannot say which collateral carries it. */
  const getUncoveredBorrows = (): VaultUncoveredBorrows | null => {
    void registryVersion.value
    if (!isLoaded.value) return null
    const vault = get(toValue(vaultAddress))?.vault
    const earn = vault && isEulerEarn(vault) ? vault : null
    const sources = earn
      ? earn.strategies.filter(strategy => strategy.allocatedAssets > 0n).map(strategy => strategy.address)
      : [toValue(vaultAddress)]
    let usd = 0
    let unpricedUsd = 0
    for (const address of sources) {
      const badDebt = getVaultBadDebt(address)
      const uncovered = badDebt
        ? getUncoveredBadDebtUsd({ badDebtUsd: badDebt.badDebtUsd, openInterestTotalUsd: sumOpenInterestUsd(getOpenInterestForVault(address)) })
        : 0
      if (!uncovered) continue
      usd += uncovered
      if (badDebt?.pricing.status === 'reported') unpricedUsd += badDebt.pricing.unpricedUsd
    }
    return usd > 0 ? { usd, unpricedUsd, scope: earn ? ' in this vault\'s strategies' : '' } : null
  }

  return { weightOf, weighAll, getUncoveredBorrows }
}
