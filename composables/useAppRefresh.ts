import { useVisibleTicker } from '~/composables/useVisibleTicker'

/** Market data refreshes for every visitor; balances only with a wallet. */
export const useAppRefresh = () => {
  const { isReady: isVaultsReady, refreshVaults } = useVaults()
  const { updateBalances } = useWallets()
  const { isConnected } = useWagmi()
  const { refreshLabelsIfStale } = useEulerLabels()
  const { refreshLiquidationCoverageIfStale } = useLiquidationCoverage()
  const { refreshBadDebtIfStale } = useVaultBadDebt()
  const { refreshIfStale: refreshOpenInterestIfStale } = useCollateralOpenInterest()

  return useVisibleTicker([
    () => refreshLabelsIfStale(),
    () => refreshLiquidationCoverageIfStale(),
    () => isVaultsReady.value ? refreshVaults() : undefined,
    () => isVaultsReady.value && isConnected.value ? updateBalances() : undefined,
    () => refreshBadDebtIfStale(),
    () => refreshOpenInterestIfStale(),
  ])
}
