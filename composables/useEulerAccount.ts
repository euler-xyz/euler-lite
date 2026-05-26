import { formatUnits, getAddress, type Address } from 'viem'
import { watch, computed, ref, shallowRef, type Ref } from 'vue'
import { accountDiagnosticOwner, dataIssueLocation, type DataIssue, type Portfolio, type PortfolioBorrowPosition, type PortfolioPositionFilter, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { EulerLensAddresses } from '~/composables/useEulerAddresses'
import { useVaults } from '~/composables/useVaults'
import { useWallets } from '~/composables/useWallets'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { createAddressRefreshCoordinator } from '~/utils/address-refresh-coordinator'
import { logWarn } from '~/utils/errorHandling'
import { createRaceGuard } from '~/utils/race-guard'

const portfolio: Ref<Portfolio<VaultEntity> | undefined> = shallowRef()
const allPortfolio: Ref<Portfolio<VaultEntity> | undefined> = shallowRef()
const portfolioDiagnostics = shallowRef<DataIssue[]>([])

const isPositionsLoading = ref(true)
const isPositionsLoaded = ref(false)
const isDepositsLoading = ref(true)
const isDepositsLoaded = ref(false)
const isShowAllPositions = ref(false)

const borrowPositions = computed(() => portfolio.value?.borrows ?? [])
const depositPositions = computed(() => portfolio.value?.savings ?? [])
const allBorrowPositions = computed(() => allPortfolio.value?.borrows ?? borrowPositions.value)
const allDepositPositions = computed(() => allPortfolio.value?.savings ?? depositPositions.value)
const hiddenBorrowCount = computed(() =>
  Math.max(0, allBorrowPositions.value.length - borrowPositions.value.length),
)
const hiddenDepositCount = computed(() =>
  Math.max(0, allDepositPositions.value.length - depositPositions.value.length),
)

const positionGuard = createRaceGuard()
const refreshCoordinator = createAddressRefreshCoordinator(() => positionGuard.next())

type PortfolioRefreshSource = 'fast' | 'fresh'

interface PortfolioRefreshOptions {
  source?: PortfolioRefreshSource
  preempt?: boolean
}

const usdWadToNumber = (value: bigint | number | undefined): number => {
  if (value === undefined) return 0
  return typeof value === 'bigint' ? Number(formatUnits(value, 18)) : value
}

const buildVisiblePortfolioPositionFilter = (): PortfolioPositionFilter<VaultEntity> => {
  const { verifiedVaultAddresses, earnVaults } = useEulerLabels()
  const { escrowAddresses, getEscrowVaults } = useVaultRegistry()

  const visibleVaults = new Set<string>()
  for (const vault of verifiedVaultAddresses.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of earnVaults.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of escrowAddresses.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of getEscrowVaults()) visibleVaults.add(getAddress(vault.address).toLowerCase())

  return (position, { account }) => {
    if (!visibleVaults.has(getAddress(position.vaultAddress).toLowerCase())) {
      return false
    }

    if (position.borrowed === 0n) return true

    const collateralAddresses = position.liquidity?.collaterals.map(collateral => collateral.address)
      ?? account.getSubAccount(position.account)?.enabledCollaterals
      ?? []

    return collateralAddresses.every(collateral =>
      visibleVaults.has(getAddress(collateral).toLowerCase()),
    )
  }
}

export const useEulerAccount = () => {
  const { isLoaded: isBalancesLoaded } = useWallets()
  const { isReady: isLabelsReady } = useEulerLabels()
  const { isReady: isVaultsReady } = useVaults()
  const { isReady: isEulerAddressesReady, chainId } = useEulerAddresses()
  const { address } = useWagmi()
  const { spyAddress } = useSpyMode()
  const portfolioAddress = computed(() => normalizeAddressOrEmpty(spyAddress.value) || normalizeAddressOrEmpty(address.value))

  const markLoaded = () => {
    isPositionsLoading.value = false
    isPositionsLoaded.value = true
    isDepositsLoading.value = false
    isDepositsLoaded.value = true
  }

  const resetLoadingState = () => {
    portfolio.value = undefined
    allPortfolio.value = undefined
    portfolioDiagnostics.value = []
    isPositionsLoaded.value = false
    isPositionsLoading.value = true
    isDepositsLoaded.value = false
    isDepositsLoading.value = true
  }

  const fetchAndUpdatePortfolio = async (
    walletAddress: string,
    refreshOptions: PortfolioRefreshOptions = {},
  ) => {
    if (refreshOptions.preempt) {
      positionGuard.next()
      refreshCoordinator.reset()
    }

    const refreshToken = refreshCoordinator.begin(walletAddress)
    if (!refreshToken) return
    const gen = positionGuard.current()

    try {
      if (!walletAddress) {
        portfolio.value = undefined
        allPortfolio.value = undefined
        portfolioDiagnostics.value = []
        markLoaded()
        return
      }

      const { getEulerSdk, getEulerSdkFresh } = useEulerSdk()
      // Portfolio reads default to the fresh (onchain) instance so positions,
      // balances and health always reflect the latest block. Callers can opt
      // back into the cached V3-backed instance with `source: 'fast'`.
      const sdk = refreshOptions.source === 'fast'
        ? await getEulerSdk()
        : await getEulerSdkFresh()
      const options = isShowAllPositions.value
        ? undefined
        : { positionFilter: buildVisiblePortfolioPositionFilter() }
      const fetched = await sdk.portfolioService.fetchPortfolio(
        chainId.value,
        getAddress(walletAddress) as Address,
        options,
      )
      fetched.errors.forEach(issue => logWarn('useEulerAccount/fetchPortfolio', issue))

      if (positionGuard.isStale(gen)) return

      const nextAllPortfolio = isShowAllPositions.value
        ? fetched.result
        : sdk.portfolioService.buildPortfolio(fetched.result.account)

      if (positionGuard.isStale(gen)) return

      portfolio.value = fetched.result
      allPortfolio.value = nextAllPortfolio
      portfolioDiagnostics.value = fetched.errors
      markLoaded()
    }
    catch (error) {
      if (positionGuard.isStale(gen)) return
      logWarn('useEulerAccount/fetchAndUpdatePortfolio', error)
      portfolioDiagnostics.value = [{
        code: 'SOURCE_UNAVAILABLE',
        severity: 'error',
        message: 'Failed to load portfolio data.',
        locations: [
          dataIssueLocation(accountDiagnosticOwner(chainId.value, getAddress(walletAddress) as Address)),
        ],
        source: 'portfolioService',
        originalValue: error instanceof Error ? error.message : String(error),
      }]
      markLoaded()
    }
    finally {
      await refreshCoordinator.finish(refreshToken, () => fetchAndUpdatePortfolio(walletAddress, refreshOptions))
    }
  }

  const maybeUpdatePositions = () => {
    if (isBalancesLoaded.value && isEulerAddressesReady.value && isLabelsReady.value && isVaultsReady.value) {
      void fetchAndUpdatePortfolio(portfolioAddress.value)
    }
  }

  watch([isBalancesLoaded, isEulerAddressesReady, isLabelsReady, isVaultsReady], () => {
    maybeUpdatePositions()
  }, { immediate: true })

  watch(portfolioAddress, (newAddress, oldAddress) => {
    if (newAddress !== oldAddress) {
      positionGuard.next()
      refreshCoordinator.reset()
      resetLoadingState()
      maybeUpdatePositions()
    }
  })

  watch(isShowAllPositions, () => {
    positionGuard.next()
    refreshCoordinator.reset()
    resetLoadingState()
    maybeUpdatePositions()
  })

  const portfolioRoe = computed(() => portfolio.value?.roe ?? 0)
  const portfolioNetApy = computed(() => portfolio.value?.netApy ?? 0)
  const totalSuppliedValue = computed(() => usdWadToNumber(portfolio.value?.totalSuppliedValueUsd))
  const totalBorrowedValue = computed(() => usdWadToNumber(portfolio.value?.totalBorrowedValueUsd))
  const netAssetMarketValue = computed(() => usdWadToNumber(portfolio.value?.netAssetValueUsd))
  const totalSuppliedValueInfo = computed(() => ({
    total: totalSuppliedValue.value,
    hasMissingPrices: portfolio.value?.totalSuppliedValueUsd === undefined
      && (depositPositions.value.length > 0 || borrowPositions.value.length > 0),
  }))
  const totalBorrowedValueInfo = computed(() => ({
    total: totalBorrowedValue.value,
    hasMissingPrices: portfolio.value?.totalBorrowedValueUsd === undefined
      && borrowPositions.value.length > 0,
  }))
  const netAssetMarketValueInfo = computed(() => ({
    total: netAssetMarketValue.value,
    hasMissingPrices: portfolio.value?.netAssetValueUsd === undefined
      && (depositPositions.value.length > 0 || borrowPositions.value.length > 0),
  }))

  watch(chainId, () => {
    positionGuard.next()
    refreshCoordinator.reset()
    resetLoadingState()
    maybeUpdatePositions()
  })

  const getPositionBySubAccountIndex = (subAccountIndex: number): PortfolioBorrowPosition<VaultEntity> | undefined => {
    const owner = portfolioAddress.value || address.value
    if (!owner) return undefined

    return allBorrowPositions.value.find((position) => {
      try {
        const ownerBigInt = BigInt(getAddress(owner))
        const subAccountBigInt = BigInt(getAddress(position.subAccount))
        const index = Number(ownerBigInt ^ subAccountBigInt)
        return index === subAccountIndex
      }
      catch {
        return false
      }
    })
  }

  const refreshAllPositions = async (
    _lensAddresses?: EulerLensAddresses,
    walletAddress = portfolioAddress.value,
    refreshOptions?: PortfolioRefreshOptions,
  ) => {
    await fetchAndUpdatePortfolio(walletAddress, refreshOptions)
  }

  return {
    portfolio,
    portfolioDiagnostics,
    borrowPositions,
    depositPositions,
    isPositionsLoading,
    isPositionsLoaded,
    isDepositsLoading,
    isDepositsLoaded,
    isShowAllPositions,
    hiddenBorrowCount,
    hiddenDepositCount,
    portfolioAddress,
    refreshAllPositions,
    getPositionBySubAccountIndex,
    totalSuppliedValue,
    totalSuppliedValueInfo,
    totalBorrowedValue,
    totalBorrowedValueInfo,
    netAssetMarketValue,
    netAssetMarketValueInfo,
    portfolioRoe,
    portfolioNetApy,
  }
}
