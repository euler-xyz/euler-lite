import type { Ref, ComputedRef } from 'vue'
import { useAccount } from '@wagmi/vue'
import { formatUnits, getAddress, zeroAddress, type Address } from 'viem'
import { isNativeCurrencyAddress, resolveWrappedNativeAddress, resolveWrappedNativeAsset } from '~/utils/native-currency'
import { FixedPoint } from '~/utils/fixed-point'
import { logWarn } from '~/utils/errorHandling'
import { getTotalCollateralValue } from '~/utils/position-estimates'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import { getNetAPY, getProjectedRates, type Vault, type VaultAsset } from '~/entities/vault'
import { getAssetUsdValue, getAssetUsdValueOrZero, getTokenUsdValue } from '~/services/pricing/priceProvider'
import type { AccountBorrowPosition } from '~/entities/account'
import type { TxPlan } from '~/entities/txPlan'
import { valueToNano } from '~/utils/crypto-utils'
import { formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'
import { amountToPercent, percentToAmountNano } from '~/utils/repayUtils'
import { SwapperMode } from '~/entities/swap'
import { createRaceGuard } from '~/utils/race-guard'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import { useSwapRepayQuotes } from '~/composables/repay/useSwapRepayQuotes'
import { getSwapInputAmount } from '~/composables/useEulerOperations/swaps/verify'
import { findBlockingDisabledOp, OP_REPAY, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import { getPlanHookDisabledWarning } from '~/composables/useVaultWarnings'

interface UseWalletSwapRepayOptions {
  position: Ref<AccountBorrowPosition | undefined>
  borrowVault: ComputedRef<AccountBorrowPosition['borrow'] | undefined>
  collateralVault: ComputedRef<AccountBorrowPosition['collateral'] | undefined>
  formTab: Ref<string>
  plan: Ref<TxPlan | null>
  isSubmitting: Ref<boolean>
  isPreparing: Ref<boolean>
  slippage: Readonly<Ref<number>>
  clearSimulationError: () => void
  runSimulation: (plan: TxPlan) => Promise<boolean>
  netAPY: Ref<number>
  collateralSupplyApy: ComputedRef<number>
  borrowApy: ComputedRef<number>
  collateralSupplyRewardApy: ComputedRef<number>
  borrowRewardApy: ComputedRef<number>
  oraclePriceRatio: ComputedRef<number | null>
}

export const useWalletSwapRepay = (options: UseWalletSwapRepayOptions) => {
  const {
    position,
    borrowVault,
    collateralVault,
    formTab,
    plan,
    isSubmitting,
    isPreparing,
    slippage,
    clearSimulationError,
    runSimulation,
    netAPY,
    collateralSupplyApy,
    borrowApy,
    collateralSupplyRewardApy,
    borrowRewardApy,
    oraclePriceRatio,
  } = options

  const router = useRouter()
  const modal = useModal()
  const { error } = useToast()
  const { buildSwapAndRepayPlan, executeTxPlan } = useEulerOperations()
  const { refreshAllPositions } = useEulerAccount()
  const { eulerLensAddresses, chainId } = useEulerAddresses()
  const { isConnected, address } = useAccount()
  const { fetchSingleBalance } = useWallets()
  const { getVault: registryGetVault } = useVaultRegistry()

  // --- State ---
  const selectedAsset = ref<VaultAsset | undefined>()
  const selectedAssetBalance = ref(0n)
  const isUnknownSwapToken = ref(false)
  const amount = ref('')
  const debtAmount = ref('')
  const direction = ref(SwapperMode.EXACT_IN)
  const debtPercent = ref(0)

  // --- Swap quotes (dual-direction) ---
  const quotes = useSwapRepayQuotes({ direction })
  // --- Derived ---
  const needsSwap = computed(() => {
    if (!selectedAsset.value || !borrowVault.value) return false
    try {
      return getAddress(selectedAsset.value.address) !== getAddress(borrowVault.value.asset.address)
    }
    catch {
      return false
    }
  })

  const getCurrentDebt = () => position.value?.borrowed || 0n

  const swapEstimatedOutput = computed(() => {
    if (!quotes.effectiveQuote.value || !borrowVault.value) return ''
    const amountOut = BigInt(quotes.effectiveQuote.value.amountOutMin || 0)
    if (amountOut <= 0n) return ''
    return formatUnits(amountOut, Number(borrowVault.value.asset.decimals))
  })

  const estimatedDebtRepaid = computed(() => {
    if (!quotes.effectiveQuote.value) return 0n
    return BigInt(quotes.effectiveQuote.value.amountOut || 0)
  })

  const guaranteedDebtRepaid = computed(() => {
    if (!quotes.effectiveQuote.value) return 0n
    return BigInt(quotes.effectiveQuote.value.amountOutMin || 0)
  })

  const computedTargetDebt = computed(() => {
    if (direction.value !== SwapperMode.TARGET_DEBT || !borrowVault.value || !debtAmount.value) return 0n
    try {
      const parsed = valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
      const currentDebt = getCurrentDebt()
      return parsed >= currentDebt ? 0n : currentDebt - parsed
    }
    catch { return 0n }
  })

  const isFullRepay = computed(() => {
    if (!position.value) return false
    if (direction.value === SwapperMode.TARGET_DEBT) {
      return computedTargetDebt.value === 0n && !!debtAmount.value
    }
    const currentDebt = getCurrentDebt()
    return currentDebt > 0n && guaranteedDebtRepaid.value >= currentDebt
  })

  const swapInputDisplay = computed(() => {
    if (!quotes.effectiveQuote.value || !selectedAsset.value) return ''
    const amountIn = BigInt(quotes.effectiveQuote.value.amountIn || 0)
    if (amountIn <= 0n) return ''
    return `${formatSmartAmount(formatUnits(amountIn, Number(selectedAsset.value.decimals)))} ${selectedAsset.value.symbol}`
  })

  const swapOutputDisplay = computed(() => {
    if (!quotes.effectiveQuote.value || !borrowVault.value) return ''
    const amountOut = BigInt(quotes.effectiveQuote.value.amountOut || 0)
    if (amountOut <= 0n) return ''
    return `${formatSmartAmount(formatUnits(amountOut, Number(borrowVault.value.asset.decimals)))} ${borrowVault.value.asset.symbol}`
  })

  const swapRoutedVia = computed(() => {
    if (!quotes.selectedProvider.value) return 'Not selected'
    if (!quotes.effectiveQuote.value?.route?.length) return null
    return quotes.effectiveQuote.value.route.map((r: { providerName: string }) => r.providerName).join(', ')
  })

  const { priceImpact: swapPriceImpact } = useSwapPriceImpact({
    quote: quotes.effectiveQuote,
    toVault: borrowVault as Ref<Vault | undefined>,
  })

  const swapRouteItems = computed(() => {
    if (!borrowVault.value) return []
    return buildSwapRouteItems({
      quoteCards: quotes.sortedQuoteCards.value,
      getQuoteDiffPct: quotes.getQuoteDiffPct,
      decimals: Number(borrowVault.value.asset.decimals),
      symbol: borrowVault.value.asset.symbol,
      formatAmount: formatSmartAmount,
    })
  })

  // --- Health estimates ---
  const hasEstimate = ref(false)
  const _estimateNetAPY = ref(0)
  const _estimateUserLTV = ref(0n)
  const _estimateHealth = ref(0n)
  const estimateNetAPY = computed(() => hasEstimate.value ? _estimateNetAPY.value : netAPY.value)
  const estimateUserLTV = computed(() => hasEstimate.value ? _estimateUserLTV.value : (position.value?.userLTV ?? 0n))
  const estimateHealth = computed(() => hasEstimate.value ? _estimateHealth.value : (position.value?.health ?? 0n))
  const estimatesError = ref('')
  const isEstimatesLoading = ref(false)

  const borrowedFixed = computed(() => FixedPoint.fromValue(position.value?.borrowed || 0n, position.value?.borrow.decimals || 18))
  const suppliedFixed = computed(() => FixedPoint.fromValue(position.value?.supplied || 0n, position.value?.collateral.decimals || 18))
  const priceFixed = computed(() => {
    const ratio = oraclePriceRatio.value
    if (ratio && Number.isFinite(ratio) && ratio > 0) {
      return FixedPoint.fromValue(BigInt(Math.round(ratio * 1e18)), 18)
    }
    return FixedPoint.fromValue(0n, 18)
  })

  // --- USD values for source/debt comparison (used by onSourceMax) ---
  // Source may be an arbitrary wallet token (possibly without a vault), so
  // fall back to backend-price feed via getTokenUsdValue.
  const sourceValueUsdGuard = createRaceGuard()
  const sourceValueUsd = ref<number | null>(null)
  watchEffect(async () => {
    const gen = sourceValueUsdGuard.next()
    if (!selectedAsset.value || selectedAssetBalance.value <= 0n) {
      sourceValueUsd.value = null
      return
    }
    // Native tokens (zero address) aren't indexed by the backend price feed;
    // resolve to the wrapped native address for pricing.
    const rawAddress = selectedAsset.value.address
    const priceAddress = isNativeCurrencyAddress(rawAddress) && chainId.value
      ? (resolveWrappedNativeAddress(chainId.value) ?? rawAddress)
      : rawAddress
    const result = (await getTokenUsdValue(
      selectedAssetBalance.value,
      Number(selectedAsset.value.decimals),
      priceAddress,
      null,
    )) ?? null
    if (sourceValueUsdGuard.isStale(gen)) return
    sourceValueUsd.value = result
  })

  const borrowValueUsdGuard = createRaceGuard()
  const borrowValueUsd = ref<number | null>(null)
  watchEffect(async () => {
    const gen = borrowValueUsdGuard.next()
    if (!borrowVault.value || !position.value) {
      borrowValueUsd.value = null
      return
    }
    const result = (await getAssetUsdValue(position.value.borrowed, borrowVault.value, 'off-chain')) ?? null
    if (borrowValueUsdGuard.isStale(gen)) return
    borrowValueUsd.value = result
  })

  // --- Validation ---
  const isRepayExceedsDebt = computed(() => {
    if (!position.value || position.value.borrowed <= 0n) return false
    if (direction.value === SwapperMode.EXACT_IN) {
      if (estimatedDebtRepaid.value === 0n) return false
      return estimatedDebtRepaid.value > position.value.borrowed
    }
    if (direction.value === SwapperMode.TARGET_DEBT && debtAmount.value && borrowVault.value) {
      try {
        const inputNano = valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
        return inputNano > position.value.borrowed
      }
      catch { return false }
    }
    return false
  })

  // Swap & repay: the swapper multicall internally calls repay() on the
  // borrow vault (OP_REPAY). Full repay additionally sweeps collateral
  // shares back to the main account via transferFromMax (OP_TRANSFER).
  const walletSwapRepayPlannedOps = computed<PlannedOp[]>(() => {
    const steps: PlannedOp[] = []
    if (borrowVault.value) steps.push({ vault: borrowVault.value, op: OP_REPAY })
    if (isFullRepay.value) {
      const collAddrs = position.value?.collaterals ?? (collateralVault.value ? [collateralVault.value.address] : [])
      for (const addr of collAddrs) {
        const v = registryGetVault(addr) as Vault | undefined
        if (v) steps.push({ vault: v, op: OP_TRANSFER })
      }
    }
    return steps
  })

  const hookWarning = computed(() => getPlanHookDisabledWarning(walletSwapRepayPlannedOps.value))

  const disabledReason = computed(() => {
    if (isRepayExceedsDebt.value) {
      return 'You repaying more than required'
    }
    return undefined
  })

  const isSubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (findBlockingDisabledOp(walletSwapRepayPlannedOps.value)) return true
    if (direction.value === SwapperMode.EXACT_IN && !(+amount.value)) return true
    if (direction.value === SwapperMode.TARGET_DEBT && !(+debtAmount.value)) return true
    if (isRepayExceedsDebt.value) return true
    if (needsSwap.value && !quotes.selectedQuote.value) return true
    if (direction.value === SwapperMode.EXACT_IN && selectedAssetBalance.value < valueToNano(amount.value, selectedAsset.value?.decimals)) return true
    if (!!estimatesError.value || isEstimatesLoading.value) return true
    return false
  })

  // --- Quote requests ---
  const requestQuote = useDebounceFn(async () => {
    if (!selectedAsset.value || !borrowVault.value || !needsSwap.value || !position.value) {
      quotes.reset()
      return
    }

    const currentDebt = getCurrentDebt()
    const userAddr = (address.value || zeroAddress) as Address
    const subAccount = (position.value.subAccount || address.value || zeroAddress) as Address
    const isNative = isNativeCurrencyAddress(selectedAsset.value.address)
    const swapTokenIn = isNative
      ? resolveWrappedNativeAddress(chainId.value!)
      : selectedAsset.value.address
    if (!swapTokenIn) {
      quotes.reset()
      return
    }

    if (direction.value === SwapperMode.EXACT_IN) {
      if (!amount.value) {
        quotes.reset()
        return
      }
      let parsedAmount: bigint
      try {
        parsedAmount = valueToNano(amount.value, selectedAsset.value.decimals)
      }
      catch {
        quotes.reset()
        return
      }
      if (parsedAmount <= 0n) {
        quotes.reset()
        return
      }
      await quotes.exactInQuotes.requestQuotes({
        tokenIn: swapTokenIn as Address,
        tokenOut: borrowVault.value.asset.address as Address,
        accountIn: zeroAddress as Address,
        accountOut: subAccount,
        amount: parsedAmount,
        vaultIn: zeroAddress as Address,
        receiver: borrowVault.value.address as Address,
        unusedInputReceiver: userAddr,
        slippage: slippage.value,
        swapperMode: SwapperMode.EXACT_IN,
        isRepay: true,
        targetDebt: 0n,
        currentDebt,
      })
      return
    }

    // TARGET_DEBT
    if (!debtAmount.value) {
      quotes.reset()
      return
    }
    let parsedAmount: bigint
    try {
      parsedAmount = valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
    }
    catch {
      quotes.reset()
      return
    }
    if (parsedAmount <= 0n) {
      quotes.reset()
      return
    }
    const targetDebt = parsedAmount >= currentDebt ? 0n : currentDebt - parsedAmount
    await quotes.targetDebtQuotes.requestQuotes({
      tokenIn: swapTokenIn as Address,
      tokenOut: borrowVault.value.asset.address as Address,
      accountIn: zeroAddress as Address,
      accountOut: subAccount,
      amount: parsedAmount,
      vaultIn: zeroAddress as Address,
      receiver: borrowVault.value.address as Address,
      unusedInputReceiver: userAddr,
      slippage: slippage.value,
      swapperMode: SwapperMode.TARGET_DEBT,
      isRepay: true,
      targetDebt,
      currentDebt,
    })
  }, 500)

  // --- Estimates ---
  const estimatesGuard = createRaceGuard()

  const getDebtRepaidNano = (): bigint => {
    if (!borrowVault.value) return 0n
    let debtRepaidNano: bigint
    if (direction.value === SwapperMode.TARGET_DEBT && debtAmount.value) {
      debtRepaidNano = valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
    }
    else {
      debtRepaidNano = estimatedDebtRepaid.value
    }
    const currentDebt = getCurrentDebt()
    return debtRepaidNano > currentDebt ? currentDebt : debtRepaidNano
  }

  const updateSyncEstimates = () => {
    clearSimulationError()
    estimatesError.value = ''
    if (!position.value || !collateralVault.value || !borrowVault.value) return

    try {
      if (!oraclePriceRatio.value || !Number.isFinite(oraclePriceRatio.value) || oraclePriceRatio.value <= 0) {
        throw new Error('Price data unavailable')
      }

      if (direction.value === SwapperMode.EXACT_IN) {
        if (selectedAssetBalance.value < valueToNano(amount.value, selectedAsset.value?.decimals)) {
          throw new Error('Not enough balance')
        }
      }

      if (needsSwap.value && !quotes.effectiveQuote.value && !quotes.isLoading.value) {
        throw new Error('No swap quote available')
      }

      if (direction.value === SwapperMode.TARGET_DEBT && quotes.effectiveQuote.value) {
        const neededInput = BigInt(quotes.effectiveQuote.value.amountInMax || quotes.effectiveQuote.value.amountIn || 0)
        if (selectedAssetBalance.value < neededInput) {
          throw new Error('Not enough balance')
        }
      }

      const debtRepaidNano = getDebtRepaidNano()
      const debtRepaidFixed = FixedPoint.fromValue(debtRepaidNano, Number(borrowVault.value.decimals))
      const totalValue = getTotalCollateralValue(position.value!)
      const collateralValueFl = totalValue !== null
        ? totalValue
        : suppliedFixed.value.mul(priceFixed.value).toUnsafeFloat()
      const collateralValue = FixedPoint.fromValue(
        BigInt(Math.round(collateralValueFl * 1e18)),
        18,
      )
      const userLtvFixed = collateralValue.isZero()
        ? FixedPoint.fromValue(0n, 18)
        : (borrowedFixed.value.sub(debtRepaidFixed))
            .div(collateralValue)
            .mul(FixedPoint.fromValue(100n, 0))
      const healthFixed = (userLtvFixed.isZero() || userLtvFixed.isNegative())
        ? null
        : FixedPoint.fromValue(position.value!.liquidationLTV, 2).div(userLtvFixed)

      _estimateUserLTV.value = userLtvFixed.toScaledBigint(18)
      _estimateHealth.value = healthFixed ? healthFixed.toScaledBigint(18) : 10n ** 36n
      hasEstimate.value = true

      if (userLtvFixed.gte(FixedPoint.fromValue(position.value!.liquidationLTV, 2))) {
        throw new Error('Not enough liquidity for the vault, LTV is too large')
      }
    }
    catch (e: unknown) {
      logWarn('walletSwapRepay/syncEstimates', e)
      hasEstimate.value = false
      estimatesError.value = (e as { message: string }).message
    }
  }

  const updateAsyncEstimates = useDebounceFn(async () => {
    if (!position.value || !collateralVault.value || !borrowVault.value) {
      isEstimatesLoading.value = false
      return
    }
    const gen = estimatesGuard.next()
    try {
      const debtRepaidNano = getDebtRepaidNano()
      const currentDebt = getCurrentDebt()
      const nextBorrowed = currentDebt - debtRepaidNano

      const [projected, supplyUsd, borrowUsd] = await Promise.all([
        getProjectedRates(
          borrowVault.value.address,
          borrowVault.value.interestRateInfo.cash,
          borrowVault.value.interestRateInfo.borrows,
          debtRepaidNano,
          -debtRepaidNano,
        ),
        getAssetUsdValueOrZero(position.value.supplied || 0n, collateralVault.value, 'off-chain'),
        getAssetUsdValueOrZero(nextBorrowed > 0n ? nextBorrowed : 0n, borrowVault.value, 'off-chain'),
      ])
      if (estimatesGuard.isStale(gen)) return

      const projectedBorrowApy = projected
        ? borrowApy.value + (nanoToValue(projected.borrowAPY, 25) - nanoToValue(borrowVault.value.interestRateInfo.borrowAPY, 25))
        : borrowApy.value

      _estimateNetAPY.value = getNetAPY(
        supplyUsd,
        collateralSupplyApy.value,
        borrowUsd,
        projectedBorrowApy,
        collateralSupplyRewardApy.value || null,
        borrowRewardApy.value || null,
      )
    }
    catch (e: unknown) {
      if (estimatesGuard.isStale(gen)) return
      logWarn('walletSwapRepay/asyncEstimates', e)
    }
    finally {
      if (!estimatesGuard.isStale(gen)) {
        isEstimatesLoading.value = false
      }
    }
  }, 500)

  // --- Helpers ---
  const resetDerivedState = () => {
    estimatesGuard.next()
    hasEstimate.value = false
    estimatesError.value = ''
    isEstimatesLoading.value = false
  }

  // --- Input handlers ---
  const onAmountInput = () => {
    clearSimulationError()
    debtAmount.value = ''
    debtPercent.value = 0
    direction.value = SwapperMode.EXACT_IN
    quotes.reset()
    resetDerivedState()
    requestQuote()
  }

  const onDebtInput = () => {
    clearSimulationError()
    amount.value = ''
    direction.value = SwapperMode.TARGET_DEBT
    quotes.reset()
    resetDerivedState()
    const currentDebt = getCurrentDebt()
    let amountNano = 0n
    try {
      amountNano = valueToNano(debtAmount.value || '0', borrowVault.value?.asset.decimals)
    }
    catch {
      amountNano = 0n
    }
    debtPercent.value = amountToPercent(amountNano, currentDebt)
    requestQuote()
  }

  const onPercentInput = () => {
    clearSimulationError()
    amount.value = ''
    direction.value = SwapperMode.TARGET_DEBT
    quotes.reset()
    resetDerivedState()
    const currentDebt = getCurrentDebt()
    if (!borrowVault.value || currentDebt <= 0n) {
      debtAmount.value = ''
      debtPercent.value = 0
      return
    }
    const amountNano = percentToAmountNano(debtPercent.value, currentDebt)
    debtAmount.value = trimTrailingZeros(formatUnits(amountNano, Number(borrowVault.value.asset.decimals)))
    requestQuote()
  }

  const onSelectSwapAsset = async (newAsset: VaultAsset, meta?: { isUnknownToken?: boolean }) => {
    selectedAsset.value = newAsset
    isUnknownSwapToken.value = meta?.isUnknownToken ?? false
    amount.value = ''
    debtAmount.value = ''
    debtPercent.value = 0
    direction.value = SwapperMode.EXACT_IN
    clearSimulationError()
    quotes.reset()
    resetDerivedState()

    if (newAsset.address) {
      selectedAssetBalance.value = await fetchSingleBalance(newAsset.address)
    }
  }

  const onRefreshSwapQuotes = () => {
    quotes.reset()
    resetDerivedState()
    requestQuote()
  }

  // Max on source input: if source is worth at least as much as the debt,
  // behave like Max on debt (TARGET_DEBT with full debt). Otherwise default
  // to EXACT_IN with full source balance. Prevents accidental over-repay.
  const onSourceMax = () => {
    if (!selectedAsset.value || !borrowVault.value || !position.value) return
    const currentDebt = getCurrentDebt()
    if (currentDebt <= 0n) return

    const sourceDecimals = Number(selectedAsset.value.decimals)
    const borrowDecimals = Number(borrowVault.value.asset.decimals)

    // No swap: source asset == borrow asset, 1:1 comparison in native units
    if (!needsSwap.value) {
      const cap = selectedAssetBalance.value < currentDebt ? selectedAssetBalance.value : currentDebt
      amount.value = trimTrailingZeros(formatUnits(cap, sourceDecimals))
      onAmountInput()
      return
    }

    // Swap: compare USD values
    const srcUsd = sourceValueUsd.value
    const debtUsd = borrowValueUsd.value
    if (srcUsd !== null && debtUsd !== null && srcUsd >= debtUsd) {
      debtAmount.value = trimTrailingZeros(formatUnits(currentDebt, borrowDecimals))
      onDebtInput()
      return
    }
    amount.value = trimTrailingZeros(formatUnits(selectedAssetBalance.value, sourceDecimals))
    onAmountInput()
  }

  // Refresh selected asset balance and re-validate when wallet address changes
  watch(address, async () => {
    if (selectedAsset.value?.address) {
      selectedAssetBalance.value = await fetchSingleBalance(selectedAsset.value.address)
      if (needsSwap.value) {
        updateSyncEstimates()
        updateAsyncEstimates()
      }
    }
  })

  watch(slippage, () => {
    if (formTab.value !== 'wallet' || !needsSwap.value) return
    clearSimulationError()
    quotes.reset()
    resetDerivedState()
    requestQuote()
  })

  // --- Watch quote changes → sync opposite field + estimates ---
  watch([quotes.effectiveQuote, direction], () => {
    if (formTab.value !== 'wallet' || !needsSwap.value) return
    if (!quotes.effectiveQuote.value || !selectedAsset.value || !borrowVault.value) return

    // Sync the opposite input field
    if (direction.value === SwapperMode.TARGET_DEBT) {
      const amountIn = BigInt(quotes.effectiveQuote.value.amountIn || 0)
      if (amountIn > 0n) {
        amount.value = trimTrailingZeros(formatUnits(amountIn, Number(selectedAsset.value.decimals)))
      }
    }
    else {
      // EXACT_IN: sync debt amount from quote output
      const amountOut = BigInt(quotes.effectiveQuote.value.amountOut || 0)
      if (amountOut > 0n) {
        debtAmount.value = trimTrailingZeros(formatUnits(amountOut, Number(borrowVault.value.asset.decimals)))
        const currentDebt = getCurrentDebt()
        debtPercent.value = amountToPercent(amountOut, currentDebt)
      }
    }

    updateSyncEstimates()
    if (!isEstimatesLoading.value) {
      isEstimatesLoading.value = true
    }
    updateAsyncEstimates()
  })

  // --- Build plan ---
  const buildRepayPlan = async (includePermit2Call: boolean): Promise<TxPlan> => {
    if (!position.value || !borrowVault.value || !collateralVault.value || !quotes.selectedQuote.value || !selectedAsset.value) {
      throw new Error('Missing data for swap repay plan')
    }

    const currentDebt = getCurrentDebt()
    const swapMode = direction.value
    let targetDebt = 0n

    if (swapMode === SwapperMode.TARGET_DEBT && debtAmount.value) {
      const debtAmountNano = valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
      targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
    }

    const inputAmount = getSwapInputAmount(quotes.selectedQuote.value, swapMode)

    const isNative = isNativeCurrencyAddress(selectedAsset.value.address)
    const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
    if (isNative && !wrappedAddress) {
      throw new Error('Wrapped native token not found')
    }

    return buildSwapAndRepayPlan({
      inputTokenAddress: (wrappedAddress || selectedAsset.value.address) as Address,
      inputAmount,
      quote: quotes.selectedQuote.value,
      requestedSlippage: slippage.value,
      borrowVaultAddress: borrowVault.value.address as Address,
      subAccount: (position.value.subAccount || address.value || zeroAddress) as Address,
      enabledCollaterals: position.value.collaterals ?? [collateralVault.value.address],
      isFullRepay: isFullRepay.value,
      swapperMode: swapMode,
      targetDebt,
      currentDebt,
      includePermit2Call,
      wrappedNativeInfo: isNative && wrappedAddress
        ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
        : undefined,
    })
  }

  // --- Submit ---
  const submit = async () => {
    if (isPreparing.value || isSubmitting.value || !position.value || !borrowVault.value || !collateralVault.value) {
      return
    }
    if (!needsSwap.value || !quotes.selectedQuote.value || !selectedAsset.value) return

    isPreparing.value = true
    try {
      try {
        plan.value = await buildRepayPlan(false)
      }
      catch (e) {
        logWarn('walletSwapRepay/buildPlan', e)
        plan.value = null
        error('Unable to prepare transaction')
        return
      }

      if (!plan.value) return

      const ok = await runSimulation(plan.value)
      if (!ok) return

      // For review modal: show input token as primary asset, borrow asset as swap target
      const inputDisplay = direction.value === SwapperMode.TARGET_DEBT && amount.value
        ? amount.value
        : (amount.value || '0')

      const isNativeRepay = isNativeCurrencyAddress(selectedAsset.value.address)
      const reviewAsset = isNativeRepay
        ? (resolveWrappedNativeAsset(chainId.value!) || selectedAsset.value)
        : selectedAsset.value
      modal.open(OperationReviewModal, {
        props: {
          type: 'repay',
          asset: reviewAsset,
          amount: inputDisplay,
          swapToAsset: borrowVault.value.asset,
          swapToAmount: swapEstimatedOutput.value,
          plan: plan.value || undefined,
          subAccount: position.value?.subAccount,
          hasBorrows: (position.value?.borrowed || 0n) > 0n,
          onConfirm: async () => {
            await send()
          },
          submittingLabel: 'Submitting...',
        },
      })
    }
    finally {
      isPreparing.value = false
    }
  }

  const send = async () => {
    try {
      isSubmitting.value = true
      if (!position.value || !borrowVault.value || !collateralVault.value || !quotes.selectedQuote.value || !selectedAsset.value) return

      const txPlan = await buildRepayPlan(true)
      await executeTxPlan(txPlan)

      modal.close()
      refreshAllPositions(eulerLensAddresses.value, address.value as string)
      setTimeout(() => {
        router.replace('/portfolio')
      }, 400)
    }
    catch (e) {
      error('Transaction failed')
      logWarn('walletSwapRepay/send', e)
    }
    finally {
      isSubmitting.value = false
    }
  }

  const resetOnTabSwitch = () => {
    amount.value = ''
    debtAmount.value = ''
    debtPercent.value = 0
    direction.value = SwapperMode.EXACT_IN
    quotes.reset()
    resetDerivedState()
  }

  const initEstimates = () => {
    hasEstimate.value = false
    estimatesError.value = ''
    isEstimatesLoading.value = false
  }

  return {
    // State
    selectedAsset,
    selectedAssetBalance,
    isUnknownSwapToken,
    amount,
    debtAmount,
    direction,
    debtPercent,
    needsSwap,

    // Swap quotes
    quotes,
    swapEstimatedOutput,
    swapInputDisplay,
    swapOutputDisplay,
    swapRoutedVia,
    swapPriceImpact,
    swapRouteItems,
    isFullRepay,

    // Health estimates
    estimateNetAPY,
    estimateUserLTV,
    estimateHealth,
    estimatesError,
    isEstimatesLoading,
    isSubmitDisabled,
    isRepayExceedsDebt,
    disabledReason,
    hookWarning,

    // Actions
    onAmountInput,
    onDebtInput,
    onSourceMax,
    onPercentInput,
    onSelectSwapAsset,
    onRefreshSwapQuotes,
    submit,
    send,
    resetOnTabSwitch,
    initEstimates,
  }
}
