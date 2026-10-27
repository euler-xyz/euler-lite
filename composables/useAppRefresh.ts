import { useVisibleTicker } from '~/composables/useVisibleTicker'

/** Labels and liquidation coverage for every visitor; vaults and balances only with a wallet. */
export const useAppRefresh = () => {
  const { isReady: isVaultsReady, refreshVaults } = useVaults()
  const { updateBalances } = useWallets()
  const { isConnected } = useWagmi()
  const { refreshLabelsIfStale } = useEulerLabels()
  const { refreshLiquidationCoverageIfStale } = useLiquidationCoverage()
  const hasWalletAndVaults = () => isConnected.value && isVaultsReady.value

  return useVisibleTicker([
    () => refreshLabelsIfStale(),
    () => refreshLiquidationCoverageIfStale(),
    () => hasWalletAndVaults() ? updateBalances() : undefined,
    () => hasWalletAndVaults() ? refreshVaults() : undefined,
  ])
}
