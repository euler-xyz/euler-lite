import { formatUnits, getAddress, type Address } from 'viem'
import { watch, computed, effectScope, onScopeDispose, ref, shallowRef, type EffectScope, type Ref, type WatchStopHandle } from 'vue'
import { accountDiagnosticOwner, dataIssueLocation, type DataIssue, type Portfolio, type PortfolioBorrowPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { EulerLensAddresses } from '~/composables/useEulerAddresses'
import { useVaults } from '~/composables/useVaults'
import { useWallets } from '~/composables/useWallets'
import { setBatchPrefetchedBaseAccount } from '~/composables/batchPrefetchState'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { createAddressRefreshCoordinator } from '~/utils/address-refresh-coordinator'
import { logWarn } from '~/utils/errorHandling'
import { buildVisiblePortfolioPositionFilter } from '~/utils/portfolioPositionFilter'
import { createRaceGuard } from '~/utils/race-guard'
import {
  activeLayerPortfolioRef,
  activeLayerPortfolioAllRef,
  activeLayerRemovedBorrowPositionsRef,
  activeLayerRemovedBorrowPositionsAllRef,
  activeLayerRemovedDepositPositionsRef,
  activeLayerRemovedDepositPositionsAllRef,
  activeLayerRemovedKeysRef,
} from '~/composables/useTxBatch'

const visiblePortfolio: Ref<Portfolio<VaultEntity> | undefined> = shallowRef()
const allPortfolio: Ref<Portfolio<VaultEntity> | undefined> = shallowRef()
const portfolioDiagnostics = shallowRef<DataIssue[]>([])

const isPositionsLoading = ref(true)
const isPositionsLoaded = ref(false)
const isDepositsLoading = ref(true)
const isDepositsLoaded = ref(false)
const isShowAllPositions = ref(false)

// Transparent layer overlay: when a non-zero batch layer is active, the
// simulated portfolio is served for both the visible and all-positions views,
// so the "Show all" toggle keeps working in simulated state exactly as on real
// data. Layer 0 (no batch / base pointer) ⇒ refs are undefined ⇒ real data.
const portfolio = computed(() => {
  const overlay = isShowAllPositions.value ? activeLayerPortfolioAllRef.value : activeLayerPortfolioRef.value
  return overlay ?? (isShowAllPositions.value ? allPortfolio.value : visiblePortfolio.value)
})
const borrowPositions = computed(() => portfolio.value?.borrows ?? [])
const depositPositions = computed(() => portfolio.value?.savings ?? [])
const removedBorrowPositions = computed(() =>
  isShowAllPositions.value
    ? activeLayerRemovedBorrowPositionsAllRef.value
    : activeLayerRemovedBorrowPositionsRef.value,
)
const removedDepositPositions = computed(() =>
  isShowAllPositions.value
    ? activeLayerRemovedDepositPositionsAllRef.value
    : activeLayerRemovedDepositPositionsRef.value,
)
const removedKeys = computed(() => activeLayerRemovedKeysRef.value)
// All-positions lists also follow the active layer (the simulated all-positions
// projection), so position lookups by sub-account — used by the position pages —
// reflect simulated deposits/withdrawals/borrows just like the portfolio view.
const effectiveAllPortfolio = computed(() => activeLayerPortfolioAllRef.value ?? allPortfolio.value)
const allBorrowPositions = computed(() => effectiveAllPortfolio.value?.borrows ?? borrowPositions.value)
const allDepositPositions = computed(() => effectiveAllPortfolio.value?.savings ?? depositPositions.value)
const hiddenBorrowCount = computed(() =>
  Math.max(0, allBorrowPositions.value.length - borrowPositions.value.length),
)
const hiddenDepositCount = computed(() =>
  Math.max(0, allDepositPositions.value.length - depositPositions.value.length),
)

const positionGuard = createRaceGuard()
const refreshCoordinator = createAddressRefreshCoordinator(() => positionGuard.next())
let consumerCount = 0
let watcherScope: EffectScope | undefined
let stopWatchers: WatchStopHandle[] = []

type PortfolioRefreshSource = 'fast' | 'fresh'

interface PortfolioRefreshOptions {
  source?: PortfolioRefreshSource
  preempt?: boolean
}

const usdWadToNumber = (value: bigint | number | undefined): number => {
  if (value === undefined) return 0
  return typeof value === 'bigint' ? Number(formatUnits(value, 18)) : value
}

export const useEulerAccount = () => {
  const { isLoaded: isBalancesLoaded } = useWallets()
  const { isReady: isLabelsReady } = useEulerLabels()
  const { isReady: isVaultsReady } = useVaults()
  const { isReady: isEulerAddressesReady, chainId } = useEulerAddresses()
  // Never falls back to the connected wallet while a spy candidate is still
  // verifying — the portfolio must not show the connected user's positions
  // under an active spy banner.
  const { effectiveAddress } = useEffectiveAddress()
  const portfolioAddress = computed(() => normalizeAddressOrEmpty(effectiveAddress.value ?? ''))

  const markLoaded = () => {
    isPositionsLoading.value = false
    isPositionsLoaded.value = true
    isDepositsLoading.value = false
    isDepositsLoaded.value = true
  }

  const resetLoadingState = () => {
    visiblePortfolio.value = undefined
    allPortfolio.value = undefined
    setBatchPrefetchedBaseAccount(undefined)
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
        visiblePortfolio.value = undefined
        allPortfolio.value = undefined
        setBatchPrefetchedBaseAccount(undefined)
        portfolioDiagnostics.value = []
        markLoaded()
        return
      }

      const { getEulerSdkForChain, getEulerSdkFresh } = useEulerSdk()
      // Portfolio reads default to the fresh (onchain) instance so positions,
      // balances and health come from chain rather than the V3 backend.
      // That selects the data source, not the freshness: reads still resolve
      // through the shared QueryClient at their `FORM_STALE_TIMES` windows, and
      // post-tx `invalidateAfterTx` invalidation is what forces a re-read. Callers
      // can opt back into the cached V3-backed instance with `source: 'fast'`.
      // Capture the chain id once so the SDK backend selection and the fetch
      // can't diverge if the user switches chains mid-await.
      const targetChainId = chainId.value
      const sdk = refreshOptions.source === 'fast'
        ? await getEulerSdkForChain(targetChainId)
        : await getEulerSdkFresh()
      const fetched = await sdk.portfolioService.fetchPortfolio(
        targetChainId,
        getAddress(walletAddress) as Address,
      )
      fetched.errors.forEach(issue => logWarn('useEulerAccount/fetchPortfolio', issue))

      if (positionGuard.isStale(gen)) return

      const nextAllPortfolio = fetched.result
      const nextVisiblePortfolio = sdk.portfolioService.buildPortfolio(fetched.result.account, {
        positionFilter: buildVisiblePortfolioPositionFilter(),
      })

      if (positionGuard.isStale(gen)) return

      allPortfolio.value = nextAllPortfolio
      visiblePortfolio.value = nextVisiblePortfolio
      setBatchPrefetchedBaseAccount(nextAllPortfolio.account)
      portfolioDiagnostics.value = fetched.errors
      markLoaded()
    }
    catch (error) {
      if (positionGuard.isStale(gen)) return
      setBatchPrefetchedBaseAccount(undefined)
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

  const startWatchers = () => {
    if (stopWatchers.length) return

    watcherScope = effectScope(true)
    watcherScope.run(() => {
      stopWatchers = [
        watch([isBalancesLoaded, isEulerAddressesReady, isLabelsReady, isVaultsReady], () => {
          maybeUpdatePositions()
        }, { immediate: true }),

        watch(portfolioAddress, (newAddress, oldAddress) => {
          if (newAddress !== oldAddress) {
            positionGuard.next()
            refreshCoordinator.reset()
            resetLoadingState()
            maybeUpdatePositions()
          }
        }),

        watch(chainId, () => {
          positionGuard.next()
          refreshCoordinator.reset()
          resetLoadingState()
          maybeUpdatePositions()
        }),
      ]
    })
  }

  const releaseWatchers = () => {
    consumerCount = Math.max(0, consumerCount - 1)
    if (consumerCount > 0) return
    stopWatchers.forEach(stopWatcher => stopWatcher())
    stopWatchers = []
    watcherScope?.stop()
    watcherScope = undefined
  }

  consumerCount += 1
  startWatchers()
  onScopeDispose(releaseWatchers)

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

  const getPositionBySubAccountIndex = (subAccountIndex: number): PortfolioBorrowPosition<VaultEntity> | undefined => {
    // portfolioAddress is already the spy-safe acting address (spied owner,
    // or the connected wallet outside spy mode).
    const owner = portfolioAddress.value
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
    removedBorrowPositions,
    removedDepositPositions,
    removedKeys,
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
