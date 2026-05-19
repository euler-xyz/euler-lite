import type { EVault, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { type ProjectedRates, getProjectedRates } from '~/utils/vault/apy'
import { getAssetUsdValue, getAssetUsdValueOrZero, getAssetOraclePrice, getCollateralOraclePrice, getCollateralShareOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { computeMultipliedPriceImpact } from '~/utils/priceImpact'
import { calculateRoe, computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { computeMaxMultiplier, computeMinMultiplier, computeWeightedSupplyApy, computeLeverageDebt } from '~/utils/multiply-math'
import { getPlanHookDisabledWarning, getUtilisationWarning, getBorrowCapWarning } from '~/composables/useVaultWarnings'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { useMultiplyCollateralOptions } from '~/composables/useMultiplyCollateralOptions'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { findBlockingDisabledOp, OP_BORROW, OP_DEPOSIT, OP_SKIM, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { useAccount } from '@wagmi/vue'
import { formatUnits, zeroAddress, type Address } from 'viem'
import { OperationReviewModal } from '#components'
import type { Ref, ComputedRef } from 'vue'
import { logWarn } from '~/utils/errorHandling'
import { createRaceGuard } from '~/utils/race-guard'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { useMultiplyCowSwap } from '~/composables/borrow/useMultiplyCowSwap'
import {
  COWSWAP_ORDER_DEADLINE_SECONDS,
  COWSWAP_PROVIDER_EXTRA_DATA,
  buildOpenPositionQuoteAppData,
  getCowSwapChainConfig,
  isCowProviderOrQuote,
} from '~/entities/cowswap'
import { getNewSubAccount } from '~/composables/useSubAccounts'

export interface UseMultiplyFormOptions {
  pair: Ref<AnyBorrowVaultPair | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  collateralVault: ComputedRef<EVault | undefined>
  formTab: Ref<'borrow' | 'multiply'>

  resolvePendingSubAccount: () => Promise<string>
  isPendingSubAccountLoading: Ref<boolean>

  isGeoBlocked: ComputedRef<boolean>
  isMultiplyRestricted: ComputedRef<boolean>
}

const normalizeAddress = normalizeAddressOrEmpty

export const useMultiplyForm = (options: UseMultiplyFormOptions) => {
  const {
    pair: _pair,
    borrowVault,
    collateralVault,
    formTab: _formTab,
    resolvePendingSubAccount,
    isPendingSubAccountLoading,
    isGeoBlocked,
    isMultiplyRestricted,
  } = options

  const modal = useModal()
  const { error } = useToast()
  const { planMultiply, executePlan } = useEulerTx()
  const { isConnected, address } = useAccount()
  const { depositPositions } = useEulerAccount()
  const { chainId } = useEulerAddresses()
  const { fetchSingleBalance } = useWallets()
  const { finalizeTxAndRedirect } = useTxFinalization()
  const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
  const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
  const {
    runSimulation: runMultiplySimulation,
    simulationError: multiplySimulationError,
    clearSimulationError: clearMultiplySimulationError,
  } = useTransactionPlanSimulation()

  const multiplyPriceInvert = usePriceInvert(
    () => multiplyShortVault.value?.asset.symbol,
    () => multiplyLongVault.value?.asset.symbol,
  )

  const { slippage: multiplySlippage } = useSlippage({
    fromSymbol: () => borrowVault.value?.asset.symbol,
    toSymbol: () => collateralVault.value?.asset.symbol,
  })
  const {
    sortedQuoteCards: multiplyQuoteCardsSorted,
    selectedProvider: multiplySelectedProvider,
    selectedQuote: multiplySelectedQuote,
    effectiveQuote: multiplyEffectiveQuote,
    effectiveQuoteFetchedAt: multiplyEffectiveQuoteFetchedAt,
    providersCount: multiplyProvidersCount,
    isLoading: isMultiplyQuoteLoading,
    quoteError: multiplyQuoteError,
    statusLabel: multiplyQuotesStatusLabel,
    getQuoteDiffPct,
    reset: resetMultiplyQuoteStateInternal,
    requestQuotes: requestMultiplyQuotes,
    selectProvider: selectMultiplyQuote,
  } = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max', includeCowSwap: true })
  // --- Form state ---
  const multiplyInputAmount = ref('')
  const multiplier = ref(1)
  const multiplyLongAmount = ref('')
  const multiplyShortAmount = ref('')
  const multiplySupplyVault: Ref<EVault | undefined> = ref()
  const multiplyAssetBalance: Ref<bigint> = ref(0n)
  const isMultiplySavingCollateral = ref(false)
  const isMultiplySubmitting = ref(false)
  const isMultiplyPreparing = ref(false)
  const multiplyPlan = ref<TransactionPlan | null>(null)

  // --- Vault aliases ---
  const multiplyLongVault = computed(() => collateralVault.value)
  const multiplyShortVault = computed(() => borrowVault.value)

  // --- Collateral options ---
  const { collateralOptions: multiplyCollateralOptions, collateralVaults: multiplyCollateralVaults } = useMultiplyCollateralOptions({
    primaryCollateralVault: multiplyLongVault,
    liabilityVault: multiplyShortVault,
  })

  // --- Product labels ---
  const multiplySupplyProduct = useEulerProductOfVault(computed(() => multiplySupplyVault.value?.address || ''))
  const multiplyLongProduct = useEulerProductOfVault(computed(() => multiplyLongVault.value?.address || ''))
  const multiplyShortProduct = useEulerProductOfVault(computed(() => multiplyShortVault.value?.address || ''))

  // --- Savings position ---
  const multiplySavingPosition = computed(() => {
    if (!multiplySupplyVault.value) return null
    return depositPositions.value.find(
      position => position.vault && normalizeAddress(position.vault.address) === normalizeAddress(multiplySupplyVault.value?.address),
    ) || null
  })
  const multiplySavingBalance = computed(() => multiplySavingPosition.value?.shares || 0n)

  const multiplyBalance = computed(() => {
    if (!multiplySupplyVault.value) return 0n
    if (isMultiplySavingCollateral.value) return multiplySavingPosition.value?.assets || 0n
    return multiplyAssetBalance.value
  })

  // --- Debt calculation ---
  const multiplyDebtAmountNano = computed(() => {
    if (!multiplySupplyVault.value || !multiplyShortVault.value) return 0n
    if (!multiplyInputAmount.value || multiplier.value <= 1) return 0n

    let suppliedCollateral: bigint
    try {
      suppliedCollateral = valueToNano(multiplyInputAmount.value, multiplySupplyVault.value.asset.decimals)
    }
    catch {
      return 0n
    }
    if (!suppliedCollateral) return 0n

    const rawSharePrice = getCollateralShareOraclePrice(multiplyShortVault.value, multiplySupplyVault.value)
    const collateralPriceInfo = getCollateralOraclePrice(multiplyShortVault.value, multiplySupplyVault.value)
    const liabilityPrice = getAssetOraclePrice(multiplyShortVault.value)

    if (!rawSharePrice || !rawSharePrice.amountIn || rawSharePrice.amountIn <= 0n) return 0n
    if (!collateralPriceInfo || collateralPriceInfo.amountOutMid <= 0n) return 0n
    if (!liabilityPrice || !liabilityPrice.amountOutAsk || liabilityPrice.amountOutAsk <= 0n) return 0n

    return computeLeverageDebt({
      suppliedCollateral,
      collateralOutBid: collateralPriceInfo.amountOutBid || collateralPriceInfo.amountOutMid,
      collateralAmountIn: rawSharePrice.amountIn,
      multiplier: multiplier.value,
      liabilityIn: 10n ** BigInt(multiplyShortVault.value.asset.decimals),
      liabilityOutAsk: liabilityPrice.amountOutAsk || liabilityPrice.amountOutMid,
    })
  })

  // --- LTV / multiplier bounds ---
  const multiplyBorrowLtv = computed(() => {
    if (!multiplySupplyVault.value || !multiplyShortVault.value) return 0
    const match = multiplyShortVault.value.collaterals.find(
      ltv => normalizeAddress(ltv.address) === normalizeAddress(multiplySupplyVault.value?.address),
    )
    return match ? ltvToPercent(match.borrowLTV) : 0
  })

  const multiplyMaxMultiplier = computed(() => computeMaxMultiplier(multiplyBorrowLtv.value))

  const multiplyMinMultiplier = computed(() => computeMinMultiplier(multiplyMaxMultiplier.value))

  const multiplySupplyAmountNano = computed(() => {
    if (!multiplySupplyVault.value || !multiplyInputAmount.value) return 0n
    try {
      return valueToNano(multiplyInputAmount.value, multiplySupplyVault.value.asset.decimals)
    }
    catch {
      return 0n
    }
  })

  // --- Same-asset detection ---
  const multiplyIsSameAsset = computed(() => {
    if (!multiplyShortVault.value || !multiplyLongVault.value) return false
    return normalizeAddress(multiplyShortVault.value.asset.address) === normalizeAddress(multiplyLongVault.value.asset.address)
  })

  // --- Swap amounts ---
  const multiplySwapAmountIn = computed(() => {
    if (multiplyEffectiveQuote.value) return BigInt(multiplyEffectiveQuote.value.amountIn || 0)
    if (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n) return multiplyDebtAmountNano.value
    return 0n
  })

  const multiplySwapAmountOut = computed(() => {
    if (multiplyEffectiveQuote.value) return BigInt(multiplyEffectiveQuote.value.amountOut || 0)
    if (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n) return multiplyDebtAmountNano.value
    return 0n
  })

  const multiplySwapReady = computed(() => {
    if (isMultiplyQuoteLoading.value) return false
    return Boolean(multiplyEffectiveQuote.value || (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n))
  })

  // --- USD values (async) ---
  const multiplySupplyValueUsd = ref<number | null>(null)
  const multiplyLongValueUsd = ref<number | null>(null)
  const multiplyBorrowValueUsd = ref<number | null>(null)

  watchEffect(async () => {
    if (!multiplySupplyVault.value || !multiplySupplyAmountNano.value) {
      multiplySupplyValueUsd.value = null
      return
    }
    multiplySupplyValueUsd.value = await getAssetUsdValueOrZero(multiplySupplyAmountNano.value, multiplySupplyVault.value, 'off-chain')
  })

  watchEffect(async () => {
    if (!multiplyLongVault.value || !multiplySwapAmountOut.value) {
      multiplyLongValueUsd.value = null
      return
    }
    multiplyLongValueUsd.value = await getAssetUsdValueOrZero(multiplySwapAmountOut.value, multiplyLongVault.value, 'off-chain')
  })

  watchEffect(async () => {
    if (!multiplyShortVault.value || !multiplyDebtAmountNano.value) {
      multiplyBorrowValueUsd.value = null
      return
    }
    multiplyBorrowValueUsd.value = await getAssetUsdValueOrZero(multiplyDebtAmountNano.value, multiplyShortVault.value, 'off-chain')
  })

  const multiplyTotalSupplyUsd = computed(() => {
    if (multiplySupplyValueUsd.value === null) return null
    return multiplySupplyValueUsd.value + (multiplyLongValueUsd.value || 0)
  })

  // --- Projected rates ---
  const projectedSupplyRates = ref<ProjectedRates | null>(null)
  const projectedLongRates = ref<ProjectedRates | null>(null)
  const projectedBorrowRates = ref<ProjectedRates | null>(null)
  const projectedRatesGuard = createRaceGuard()

  watchEffect(async () => {
    const supply = multiplySupplyVault.value
    const short = multiplyShortVault.value
    const long = multiplyLongVault.value
    const supplyNano = multiplySupplyAmountNano.value
    const debtNano = multiplyDebtAmountNano.value
    const swapOut = multiplySwapAmountOut.value
    const gen = projectedRatesGuard.next()

    if (!supply || !short || !long || !supplyNano || !debtNano) {
      projectedSupplyRates.value = null
      projectedLongRates.value = null
      projectedBorrowRates.value = null
      return
    }

    try {
      const supplyAndLongSameVault = normalizeAddress(supply.address) === normalizeAddress(long.address)

      if (supplyAndLongSameVault) {
        // Combined delta for supply + long vault
        const [combined, shortResult] = await Promise.all([
          getProjectedRates(supply.address, supply.totalCash, supply.totalBorrowed, supplyNano + swapOut, 0n),
          getProjectedRates(short.address, short.totalCash, short.totalBorrowed, -debtNano, debtNano),
        ])
        if (projectedRatesGuard.isStale(gen)) return
        projectedSupplyRates.value = combined
        projectedLongRates.value = combined
        projectedBorrowRates.value = shortResult
      }
      else {
        const [supplyResult, shortResult, longResult] = await Promise.all([
          getProjectedRates(supply.address, supply.totalCash, supply.totalBorrowed, supplyNano, 0n),
          getProjectedRates(short.address, short.totalCash, short.totalBorrowed, -debtNano, debtNano),
          getProjectedRates(long.address, long.totalCash, long.totalBorrowed, swapOut, 0n),
        ])
        if (projectedRatesGuard.isStale(gen)) return
        projectedSupplyRates.value = supplyResult
        projectedLongRates.value = longResult
        projectedBorrowRates.value = shortResult
      }
    }
    catch (e) {
      if (projectedRatesGuard.isStale(gen)) return
      logWarn('multiply/projectedRates', e)
      projectedSupplyRates.value = null
      projectedLongRates.value = null
      projectedBorrowRates.value = null
    }
  })

  // --- APYs ---
  const multiplySupplyApy = computed(() => {
    if (!multiplySupplyVault.value) return null
    const currentRaw = getVaultSupplyApy(multiplySupplyVault.value)
    const base = withIntrinsicSupplyApy(currentRaw, multiplySupplyVault.value.asset.address) + getSupplyRewardApy(multiplySupplyVault.value.address)
    if (!projectedSupplyRates.value) return base
    const projectedRaw = nanoToValue(projectedSupplyRates.value.supplyAPY, 25)
    return base + (projectedRaw - currentRaw)
  })

  const multiplyLongApy = computed(() => {
    if (!multiplyLongVault.value) return null
    const currentRaw = getVaultSupplyApy(multiplyLongVault.value)
    const base = withIntrinsicSupplyApy(currentRaw, multiplyLongVault.value.asset.address) + getSupplyRewardApy(multiplyLongVault.value.address)
    if (!projectedLongRates.value) return base
    const projectedRaw = nanoToValue(projectedLongRates.value.supplyAPY, 25)
    return base + (projectedRaw - currentRaw)
  })

  const multiplyBorrowApy = computed(() => {
    if (!multiplyShortVault.value) return null
    const currentRaw = getVaultBorrowApy(multiplyShortVault.value)
    const base = withIntrinsicBorrowApy(currentRaw, multiplyShortVault.value.asset.address) - getBorrowRewardApy(multiplyShortVault.value.address, multiplySupplyVault.value?.address)
    if (!projectedBorrowRates.value) return base
    const projectedRaw = nanoToValue(projectedBorrowRates.value.borrowAPY, 25)
    return base + (projectedRaw - currentRaw)
  })

  const multiplyWeightedSupplyApy = computed(() => {
    if (multiplySupplyValueUsd.value === null || multiplySupplyApy.value === null) return null
    return computeWeightedSupplyApy(
      multiplySupplyValueUsd.value,
      multiplySupplyApy.value,
      multiplyLongValueUsd.value,
      multiplyLongApy.value,
    )
  })

  // --- ROE ---
  const multiplyRoeBefore = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (multiplySupplyValueUsd.value === null) return null
    return 0
  })

  const multiplyRoeAfter = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (
      multiplyTotalSupplyUsd.value === null
      || multiplyBorrowValueUsd.value === null
      || multiplyWeightedSupplyApy.value === null
      || multiplyBorrowApy.value === null
    ) return null
    return calculateRoe(
      multiplyTotalSupplyUsd.value,
      multiplyBorrowValueUsd.value,
      multiplyWeightedSupplyApy.value,
      multiplyBorrowApy.value,
    )
  })

  // --- Health / LTV ---
  const multiplyLiquidationLtv = computed(() => {
    if (!multiplySupplyVault.value || !multiplyShortVault.value) return null
    const match = multiplyShortVault.value.collaterals.find(
      ltv => normalizeAddress(ltv.address) === normalizeAddress(multiplySupplyVault.value?.address),
    )
    return match ? ltvToPercent(match.liquidationLTV) : null
  })

  const multiplyCurrentLtv = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (multiplySupplyValueUsd.value === null || multiplySupplyValueUsd.value <= 0) return null
    return 0
  })

  const multiplyNextLtv = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (multiplyTotalSupplyUsd.value === null || multiplyBorrowValueUsd.value === null) return null
    if (multiplyTotalSupplyUsd.value <= 0) return null
    return (multiplyBorrowValueUsd.value / multiplyTotalSupplyUsd.value) * 100
  })

  const multiplyCurrentLiquidationLtv = computed(() => null as number | null)
  const multiplyNextLiquidationLtv = computed(() => multiplyLiquidationLtv.value)

  const multiplyNextHealth = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (multiplyNextLtv.value === null || multiplyLiquidationLtv.value === null) return null
    return computeNextHealth(multiplyLiquidationLtv.value, multiplyNextLtv.value)
  })

  const multiplyCurrentHealth = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (multiplyLiquidationLtv.value === null || multiplyCurrentLtv.value === null) return null
    return computeNextHealth(multiplyLiquidationLtv.value, multiplyCurrentLtv.value)
  })

  // --- Price ratio ---
  const multiplyPriceRatio = computed(() => {
    if (!multiplyLongVault.value || !multiplyShortVault.value) return null
    const collateralPrice = getCollateralOraclePrice(multiplyShortVault.value, multiplyLongVault.value)
    const borrowPrice = getAssetOraclePrice(multiplyShortVault.value)
    return conservativePriceRatioNumber(collateralPrice, borrowPrice)
  })
  multiplyPriceInvert.autoInvert(() => multiplyPriceRatio.value)

  const multiplyCurrentLiquidationPrice = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (!multiplyPriceRatio.value || !multiplyCurrentHealth.value) return null
    if (!Number.isFinite(multiplyCurrentHealth.value)) return null
    return computeLiquidationPrice(multiplyPriceRatio.value, multiplyCurrentHealth.value)
  })

  const multiplyNextLiquidationPrice = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (!multiplyPriceRatio.value || !multiplyNextHealth.value) return null
    if (!Number.isFinite(multiplyNextHealth.value)) return null
    return computeLiquidationPrice(multiplyPriceRatio.value, multiplyNextHealth.value)
  })

  // --- Display ---
  const multiplyCurrentPrice = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (!multiplySwapReady.value || !multiplyShortVault.value || !multiplyLongVault.value) return null
    const amountIn = Number(formatUnits(multiplySwapAmountIn.value, Number(multiplyShortVault.value.asset.decimals)))
    const amountOut = Number(formatUnits(multiplySwapAmountOut.value, Number(multiplyLongVault.value.asset.decimals)))
    if (!amountIn || !amountOut) return null
    return {
      value: amountIn / amountOut,
      symbol: `${multiplyShortVault.value.asset.symbol}/${multiplyLongVault.value.asset.symbol}`,
    }
  })

  const multiplySwapSummary = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (!multiplySwapReady.value || !multiplyShortVault.value || !multiplyLongVault.value) return null
    const amountIn = formatUnits(multiplySwapAmountIn.value, Number(multiplyShortVault.value.asset.decimals))
    const amountOut = formatUnits(multiplySwapAmountOut.value, Number(multiplyLongVault.value.asset.decimals))
    return {
      from: `${formatSmartAmount(amountIn)} ${multiplyShortVault.value.asset.symbol}`,
      to: `${formatSmartAmount(amountOut)} ${multiplyLongVault.value.asset.symbol}`,
      fromExact: `${amountIn} ${multiplyShortVault.value.asset.symbol}`,
      toExact: `${amountOut} ${multiplyLongVault.value.asset.symbol}`,
    }
  })

  const multiplyPriceImpact = ref<number | null>(null)

  watchEffect(async () => {
    if (isMultiplyQuoteLoading.value) {
      multiplyPriceImpact.value = null
      return
    }
    if (!multiplySwapReady.value || !multiplyShortVault.value || !multiplyLongVault.value) {
      multiplyPriceImpact.value = null
      return
    }
    const swapIn = multiplySwapAmountIn.value
    const swapOut = multiplySwapAmountOut.value
    const shortVault = multiplyShortVault.value
    const longVault = multiplyLongVault.value
    const amountInUsd = await getAssetUsdValue(swapIn, shortVault, 'off-chain')
    const amountOutUsd = await getAssetUsdValue(swapOut, longVault, 'off-chain')
    if (!amountInUsd || !amountOutUsd) {
      multiplyPriceImpact.value = null
      return
    }
    const impact = (amountOutUsd / amountInUsd - 1) * 100
    if (!Number.isFinite(impact)) {
      multiplyPriceImpact.value = null
      return
    }
    multiplyPriceImpact.value = impact
  })

  const multipliedPriceImpact = computed(() =>
    computeMultipliedPriceImpact(multiplyPriceImpact.value, multiplier.value),
  )

  const multiplyRoutedVia = computed(() => {
    if (!multiplySelectedProvider.value) return isMultiplyQuoteLoading.value ? null : 'Not selected'
    if (!multiplyEffectiveQuote.value?.route?.length) return null
    return multiplyEffectiveQuote.value.route.map(route => route.providerName).join(', ')
  })

  const multiplyRouteItems = computed(() => {
    if (!multiplyLongVault.value) return []
    return buildSwapRouteItems({
      quoteCards: multiplyQuoteCardsSorted.value,
      getQuoteDiffPct,
      decimals: Number(multiplyLongVault.value.asset.decimals),
      symbol: multiplyLongVault.value.asset.symbol,
      formatAmount: formatSmartAmount,
    })
  })

  const multiplyRouteEmptyMessage = computed(() => {
    if (!multiplyProvidersCount.value) return 'Enter amount to fetch quotes'
    return 'No quotes found'
  })

  // --- CoW provider detection ---
  // Locally redefined here (matches the same logic in useMultiplyCowSwap) so
  // we can gate `multiplyErrorText` without a forward-reference cycle.
  const isCowSwapProvider = computed(() =>
    isCowProviderOrQuote(multiplySelectedProvider.value, multiplyEffectiveQuote.value),
  )

  // --- Validation ---
  const multiplyErrorText = computed(() => {
    if (!multiplySupplyVault.value || !multiplyShortVault.value) return null
    if (multiplyBalance.value < valueToNano(multiplyInputAmount.value, multiplySupplyVault.value.asset.decimals)) {
      return 'Not enough balance'
    }
    if (multiplyDebtAmountNano.value > 0n && multiplyShortVault.value.availableLiquidity < multiplyDebtAmountNano.value) {
      return 'Not enough liquidity in the vault'
    }
    if (isCowSwapProvider.value && isMultiplySavingCollateral.value) {
      return 'CoW Swap is not available when using savings as collateral'
    }
    if (
      isCowSwapProvider.value
      && multiplyLongVault.value
      && multiplySupplyVault.value
      && normalizeAddress(multiplySupplyVault.value.address) !== normalizeAddress(multiplyLongVault.value.address)
    ) {
      return 'CoW Swap is not available when margin vault differs from the long vault'
    }
    return null
  })

  const isSupplyCapReached = computed(() => multiplySupplyVault.value ? getIsSupplyCapReached(multiplySupplyVault.value) : false)
  const isBorrowCapReached = computed(() => multiplyShortVault.value ? getIsBorrowCapReached(multiplyShortVault.value) : false)

  // Multiply supply side: savings-sourced transfers existing shares (OP_TRANSFER);
  // fresh-supply deposits new assets (OP_DEPOSIT). The short vault is always
  // borrowed from, and any swap path touches OP_SKIM on the long vault via the
  // SkimMin verifier (skipped on same-asset multiply).
  const multiplyPlannedOps = computed<PlannedOp[]>(() => {
    const steps: PlannedOp[] = []
    if (multiplySupplyVault.value) {
      steps.push({
        vault: multiplySupplyVault.value,
        op: isMultiplySavingCollateral.value ? OP_TRANSFER : OP_DEPOSIT,
      })
    }
    if (multiplyShortVault.value) steps.push({ vault: multiplyShortVault.value, op: OP_BORROW })
    if (multiplyLongVault.value) {
      if (multiplySelectedQuote.value) {
        // Cross-asset: verifyAmountMinAndSkim calls skim() on the long vault
        steps.push({ vault: multiplyLongVault.value, op: OP_SKIM })
      }
      else if (multiplyDebtAmountNano.value > 0n) {
        // Same-asset without swap: borrowed assets deposited directly
        steps.push({ vault: multiplyLongVault.value, op: OP_DEPOSIT })
      }
    }
    return steps
  })

  const isMultiplySubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (findBlockingDisabledOp(multiplyPlannedOps.value)) return true
    if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value) return true
    if (!multiplyInputAmount.value || multiplyDebtAmountNano.value <= 0n) return true
    if (multiplyErrorText.value) return true
    if (isPendingSubAccountLoading.value) return true
    const isSameAsset = normalizeAddress(multiplyLongVault.value.asset.address) === normalizeAddress(multiplyShortVault.value.asset.address)
    if (!isSameAsset && !multiplySelectedQuote.value) return true
    if (isSupplyCapReached.value || isBorrowCapReached.value) return true
    return false
  })

  // --- Warnings ---
  const multiplyFormWarnings = computed(() => {
    if (!multiplyShortVault.value) return []
    return [
      getPlanHookDisabledWarning(multiplyPlannedOps.value),
      getUtilisationWarning(multiplyShortVault.value, 'borrow'),
      getBorrowCapWarning(multiplyShortVault.value),
    ]
  })

  // --- Swap quote ---
  const requestMultiplyQuote = useDebounceFn(async () => {
    multiplyQuoteError.value = null

    if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value || !multiplyInputAmount.value) {
      resetMultiplyQuoteState()
      return
    }

    const debtAmount = multiplyDebtAmountNano.value
    if (!debtAmount || debtAmount <= 0n) {
      resetMultiplyQuoteState()
      return
    }

    if (normalizeAddress(multiplyLongVault.value.asset.address) === normalizeAddress(multiplyShortVault.value.asset.address)) {
      resetMultiplyQuoteState()
      setMultiplyAmounts(debtAmount, debtAmount)
      return
    }

    let account: Address
    try {
      account = (await resolvePendingSubAccount()) as Address
    }
    catch {
      resetMultiplyQuoteState()
      multiplyQuoteError.value = 'Unable to resolve position'
      return
    }

    // CoW open position uses a different sub-account than the EVC batch path:
    // it must be free of controllers because the wrapper enables the borrow
    // vault controller itself. Resolve it here so the CoW quote is scoped to
    // it; if unavailable we fall back to skipping the CoW provider.
    const quoteDeadline = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
    const cowProviderExtraData = { ...COWSWAP_PROVIDER_EXTRA_DATA.openPosition }
    let cowAccount: Address | null = null
    const chainConfig = getCowSwapChainConfig(chainId.value ?? 0)
    if (chainConfig && address.value) {
      try {
        cowAccount = await getNewSubAccount(address.value, multiplyShortVault.value.address) as Address
      }
      catch (e) {
        logWarn('multiply/cowswap/resolveQuoteSubaccount', e)
      }
    }
    if (chainConfig && cowAccount) {
      cowProviderExtraData.appData = buildOpenPositionQuoteAppData(
        {
          owner: (address.value || zeroAddress) as Address,
          account: cowAccount,
          deadline: quoteDeadline,
          collateralVault: multiplySupplyVault.value.address as Address,
          borrowVault: multiplyShortVault.value.address as Address,
          collateralAmount: valueToNano(multiplyInputAmount.value || '0', multiplySupplyVault.value.asset.decimals),
          borrowAmount: debtAmount,
        },
        chainConfig.openPositionWrapper,
        Math.round(multiplySlippage.value * 100),
      )
    }

    setMultiplyAmounts(null, null)
    const requestParams = {
      tokenIn: multiplyShortVault.value.asset.address as Address,
      tokenOut: multiplyLongVault.value.asset.address as Address,
      accountIn: account,
      accountOut: account,
      amount: debtAmount,
      vaultIn: multiplyShortVault.value.address as Address,
      receiver: multiplyLongVault.value.address as Address,
      slippage: multiplySlippage.value,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      targetDebt: 0n,
      currentDebt: 0n,
    }
    await requestMultiplyQuotes(requestParams, {
      errorMessage: 'Unable to fetch swap quote. Multiply feature is not available for this asset.',
      providerExtraData: cowAccount ? { cow: cowProviderExtraData } : undefined,
      providerParams: cowAccount
        ? { cow: { accountIn: cowAccount, accountOut: cowAccount } }
        : undefined,
    })
  }, 500)

  // --- Helpers ---
  const setMultiplyAmounts = (longAmount?: bigint | null, shortAmount?: bigint | null) => {
    if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value || !multiplyInputAmount.value) {
      multiplyLongAmount.value = ''
      multiplyShortAmount.value = ''
      return
    }
    let baseNano: bigint
    try {
      baseNano = valueToNano(multiplyInputAmount.value, multiplySupplyVault.value.asset.decimals)
    }
    catch {
      multiplyLongAmount.value = ''
      multiplyShortAmount.value = ''
      return
    }
    if (!baseNano) {
      multiplyLongAmount.value = ''
      multiplyShortAmount.value = ''
      return
    }
    multiplyLongAmount.value = longAmount && longAmount > 0n
      ? trimTrailingZeros(formatUnits(longAmount, Number(multiplyLongVault.value.asset.decimals)))
      : ''
    multiplyShortAmount.value = shortAmount && shortAmount > 0n
      ? trimTrailingZeros(formatUnits(shortAmount, Number(multiplyShortVault.value.asset.decimals)))
      : ''
  }

  const resetMultiplyQuoteState = () => {
    resetMultiplyQuoteStateInternal()
    setMultiplyAmounts(null, null)
  }

  const onRefreshMultiplyQuotes = () => {
    resetMultiplyQuoteState()
    isMultiplyQuoteLoading.value = true
    requestMultiplyQuote()
  }

  // --- Actions: form input handlers ---
  const onMultiplyInput = () => {
    clearMultiplySimulationError()
    if (!multiplyInputAmount.value) {
      resetMultiplyQuoteState()
      return
    }
    requestMultiplyQuote()
  }

  const onMultiplierInput = () => {
    clearMultiplySimulationError()
    if (!multiplyInputAmount.value) {
      resetMultiplyQuoteState()
      return
    }
    requestMultiplyQuote()
  }

  const onMultiplyCollateralChange = (selectedIndex: number) => {
    clearMultiplySimulationError()
    const nextVault = multiplyCollateralVaults.value[selectedIndex]
    const nextOption = multiplyCollateralOptions.value[selectedIndex]
    if (!nextVault || !nextOption) return

    const nextIsSaving = nextOption.type === 'saving'
    const vaultChanged = !multiplySupplyVault.value
      || normalizeAddress(multiplySupplyVault.value.address) !== normalizeAddress(nextVault.address)
    const savingChanged = nextIsSaving !== isMultiplySavingCollateral.value
    if (vaultChanged || savingChanged) {
      multiplySupplyVault.value = nextVault
      isMultiplySavingCollateral.value = nextIsSaving
      multiplyInputAmount.value = ''
      resetMultiplyQuoteState()
    }
  }

  // --- CowSwap ---
  const cowSwap = useMultiplyCowSwap({
    multiplySelectedProvider: computed(() => multiplySelectedProvider.value),
    multiplyEffectiveQuote: computed(() => multiplyEffectiveQuote.value),
    multiplySelectedQuote: computed(() => multiplySelectedQuote.value),
    multiplyEffectiveQuoteFetchedAt: computed(() => multiplyEffectiveQuoteFetchedAt.value),
    multiplySlippage,
    multiplySupplyVault: computed(() => multiplySupplyVault.value),
    multiplyLongVault,
    multiplyShortVault,
    multiplySupplyProduct: computed(() => multiplySupplyProduct),
    multiplyShortProduct: computed(() => multiplyShortProduct),
    multiplyInputAmount,
    multiplyShortAmount: computed(() => multiplyShortAmount.value),
    multiplyLongAmount: computed(() => multiplyLongAmount.value),
    multiplyDebtAmountNano: computed(() => multiplyDebtAmountNano.value),
    multiplyErrorText,
  })
  const { cowSwapExecution, cowSwapOrderStatus, cowSwapStatusLabel, submitCowSwapMultiply } = cowSwap

  // --- Actions: submit & send ---
  const submitMultiply = async () => {
    if (isOperationBlocked.value) return
    if (isMultiplyPreparing.value || isGeoBlocked.value || isMultiplyRestricted.value) return

    // CowSwap branch: skip plan building and simulation, go straight to the
    // CoW review modal which signs the EVC permit + order off-chain.
    if (isCowProviderOrQuote(multiplySelectedProvider.value, multiplyEffectiveQuote.value)) {
      isMultiplyPreparing.value = true
      try {
        await submitCowSwapMultiply()
      }
      finally {
        isMultiplyPreparing.value = false
      }
      return
    }

    isMultiplyPreparing.value = true
    try {
      if (isMultiplySubmitting.value || !isConnected.value) return
      if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value) return
      if (!multiplyInputAmount.value || multiplyDebtAmountNano.value <= 0n) return
      if (multiplyErrorText.value) return

      const supplyAmountNano = valueToNano(multiplyInputAmount.value || '0', multiplySupplyVault.value.asset.decimals)
      let supplySharesAmount: bigint | undefined
      if (isMultiplySavingCollateral.value) {
        if (!multiplySavingPosition.value) {
          error('No savings balance for selected collateral')
          return
        }
        if (multiplySavingPosition.value.assets === supplyAmountNano) {
          supplySharesAmount = multiplySavingBalance.value
        }
        else {
          supplySharesAmount = multiplySupplyVault.value.convertToShares(supplyAmountNano)
        }
        if (!supplySharesAmount || supplySharesAmount <= 0n) {
          error('Unable to resolve savings amount')
          return
        }
      }
      const debtAmount = multiplyDebtAmountNano.value
      if (!supplyAmountNano || debtAmount <= 0n) return

      const isSameAsset = normalizeAddress(multiplyLongVault.value.asset.address) === normalizeAddress(multiplyShortVault.value.asset.address)
      const quote = isSameAsset ? null : multiplySelectedQuote.value
      if (!isSameAsset && !quote) return

      let subAccount: string
      try {
        subAccount = await resolvePendingSubAccount()
      }
      catch (e) {
        logWarn('multiply/resolveSubaccount', e)
        error('Unable to resolve position')
        return
      }

      const collateralShareSource = isMultiplySavingCollateral.value
        && supplySharesAmount
        && multiplySavingPosition.value
        ? {
            from: multiplySavingPosition.value.subAccount as Address,
            shares: supplySharesAmount,
          }
        : undefined
      const collateralAmount = isMultiplySavingCollateral.value ? 0n : supplyAmountNano

      try {
        multiplyPlan.value = await planMultiply({
          collateralVault: multiplySupplyVault.value.address as Address,
          collateralAmount,
          collateralAsset: multiplySupplyVault.value.asset.address as Address,
          collateralShareSource,
          longVault: multiplyLongVault.value.address as Address,
          liabilityVault: multiplyShortVault.value.address as Address,
          liabilityAmount: debtAmount,
          receiver: subAccount as Address,
          swapQuote: quote ?? undefined,
          swapperMode: SwapperMode.EXACT_IN,
        })
      }
      catch (e) {
        logWarn('multiply/buildPlan', e)
        multiplyPlan.value = null
      }

      if (multiplyPlan.value) {
        const ok = await runMultiplySimulation(multiplyPlan.value)
        if (!ok) return
      }

      modal.open(OperationReviewModal, {
        props: {
          type: 'borrow',
          asset: multiplyShortVault.value.asset,
          amount: multiplyShortAmount.value || formatUnits(debtAmount, Number(multiplyShortVault.value.asset.decimals)),
          plan: multiplyPlan.value || undefined,
          supplyingAssetForBorrow: multiplySupplyVault.value.asset,
          supplyingAmount: multiplyInputAmount.value,
          swapToAsset: quote ? multiplyLongVault.value.asset : undefined,
          swapToAmount: quote ? multiplyLongAmount.value : undefined,
          swapMode: quote ? SwapperMode.EXACT_IN : undefined,
          subAccount,
          onConfirm: () => {
            setTimeout(() => {
              sendMultiply()
            }, 400)
          },
        },
      })
    }
    finally {
      isMultiplyPreparing.value = false
    }
  }

  const sendMultiply = async () => {
    if (!multiplyPlan.value) return
    isMultiplySubmitting.value = true
    try {
      await executePlan(multiplyPlan.value)
      await finalizeTxAndRedirect()
    }
    catch (e) {
      logWarn('multiply/send', e)
      error('Transaction failed')
    }
    finally {
      isMultiplySubmitting.value = false
    }
  }

  // --- Balance ---
  const updateMultiplyAssetBalance = async () => {
    if (multiplySupplyVault.value?.asset.address && isConnected.value) {
      multiplyAssetBalance.value = await fetchSingleBalance(multiplySupplyVault.value.asset.address)
    }
    else {
      multiplyAssetBalance.value = 0n
    }
  }

  // --- Init ---
  const initMultiplySupplyVault = (vault: EVault) => {
    multiplySupplyVault.value = vault
    isMultiplySavingCollateral.value = false
  }

  // --- Watchers ---
  watch([multiplyEffectiveQuote, multiplyIsSameAsset, multiplyDebtAmountNano], () => {
    if (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n) {
      setMultiplyAmounts(multiplyDebtAmountNano.value, multiplyDebtAmountNano.value)
      return
    }
    if (multiplyEffectiveQuote.value) {
      const amountOut = BigInt(multiplyEffectiveQuote.value.amountOut || 0)
      const amountIn = BigInt(multiplyEffectiveQuote.value.amountIn || 0)
      setMultiplyAmounts(amountOut, amountIn)
      return
    }
    setMultiplyAmounts(null, null)
  }, { immediate: true })

  watch(multiplySlippage, () => {
    clearMultiplySimulationError()
    if (!multiplyInputAmount.value) {
      resetMultiplyQuoteState()
      return
    }
    requestMultiplyQuote()
  })

  watch([multiplySupplyVault, multiplyLongVault, multiplyShortVault, isMultiplySavingCollateral], () => {
    clearMultiplySimulationError()
    resetMultiplyQuoteState()
    if (multiplyInputAmount.value) {
      requestMultiplyQuote()
    }
  })

  watch(multiplySupplyVault, async (newVault) => {
    if (newVault?.asset.address && isConnected.value) {
      multiplyAssetBalance.value = await fetchSingleBalance(newVault.asset.address)
    }
    else {
      multiplyAssetBalance.value = 0n
    }
  })

  watch(multiplySelectedQuote, () => {
    clearMultiplySimulationError()
  })

  watch(multiplyMaxMultiplier, (max) => {
    let next = multiplier.value
    const min = multiplyMinMultiplier.value
    if (!max || max < min) {
      next = min
    }
    else {
      if (next > max) next = max
      if (next < min) next = min
    }
    if (next !== multiplier.value) {
      multiplier.value = next
    }
    if (!multiplyInputAmount.value) {
      resetMultiplyQuoteState()
      return
    }
    requestMultiplyQuote()
  }, { immediate: true })

  // --- Reset ---
  const resetOnTabSwitch = () => {
    clearMultiplySimulationError()
  }

  return {
    // Form state
    multiplyInputAmount,
    multiplier,
    multiplyLongAmount,
    multiplyShortAmount,
    multiplySupplyVault,
    multiplyAssetBalance,
    isMultiplySavingCollateral,
    isMultiplySubmitting,
    isMultiplyPreparing,
    multiplyPlan,

    // Vault aliases
    multiplyLongVault,
    multiplyShortVault,

    // Collateral
    multiplyCollateralOptions,
    multiplyCollateralVaults,
    multiplySavingPosition,
    multiplySavingBalance,
    multiplyBalance,

    // Debt
    multiplyDebtAmountNano,
    multiplyBorrowLtv,
    multiplyMaxMultiplier,
    multiplyMinMultiplier,
    multiplySupplyAmountNano,
    multiplyIsSameAsset,

    // Swap
    multiplySwapAmountIn,
    multiplySwapAmountOut,
    multiplySwapReady,
    multiplySlippage,
    multiplySelectedProvider,
    multiplyQuoteCardsSorted,
    isMultiplyQuoteLoading,
    multiplyQuoteError,
    multiplyQuotesStatusLabel,
    selectMultiplyQuote,

    // USD values
    multiplySupplyValueUsd,
    multiplyLongValueUsd,
    multiplyBorrowValueUsd,
    multiplyTotalSupplyUsd,

    // APY
    multiplySupplyApy,
    multiplyLongApy,
    multiplyBorrowApy,
    multiplyWeightedSupplyApy,

    // ROE
    multiplyRoeBefore,
    multiplyRoeAfter,

    // Health / LTV
    multiplyLiquidationLtv,
    multiplyCurrentLtv,
    multiplyNextLtv,
    multiplyCurrentLiquidationLtv,
    multiplyNextLiquidationLtv,
    multiplyNextHealth,
    multiplyCurrentHealth,

    // Price
    multiplyPriceRatio,
    multiplyCurrentLiquidationPrice,
    multiplyNextLiquidationPrice,
    multiplyCurrentPrice,
    multiplyPriceInvert,

    // Display
    multiplySwapSummary,
    multiplyPriceImpact,
    multipliedPriceImpact,
    multiplyRoutedVia,
    multiplyRouteItems,
    multiplyRouteEmptyMessage,
    multiplySimulationError,

    // Validation
    multiplyErrorText,
    isMultiplySubmitDisabled,
    multiplyFormWarnings,

    // Product labels
    multiplySupplyProduct,
    multiplyLongProduct,
    multiplyShortProduct,

    // CowSwap
    isCowSwapProvider,
    cowSwapExecution,
    cowSwapOrderStatus,
    cowSwapStatusLabel,
    multiplyEffectiveQuoteFetchedAt,

    // Actions
    onMultiplyInput,
    onMultiplierInput,
    onMultiplyCollateralChange,
    onRefreshMultiplyQuotes,
    submitMultiply,
    sendMultiply,
    updateMultiplyAssetBalance,
    initMultiplySupplyVault,
    resetOnTabSwitch,
  }
}
