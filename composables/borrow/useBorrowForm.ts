import type { VaultAsset } from '~/types/asset'
import type { CollateralOption } from '~/types/collateral-option'
import { isEVault, type EVault, type PortfolioSavingsPosition, type TransactionPlan, SwapperMode, type SwapQuote, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getProjectedRates, getNetAPY } from '~/utils/vault/apy'
import { findBlockingDisabledOp, OP_BORROW, OP_DEPOSIT, OP_SKIM, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { getCollateralOraclePrice, getAssetOraclePrice, conservativePriceRatio, getCollateralUsdPrice, getAssetUsdValueOrZero, getTokenUsdPrice } from '~/utils/sdk-prices'
import { getAddress, formatUnits, zeroAddress, type Address } from 'viem'
import { SwapTokenSelector, OperationReviewModal } from '#components'
import type { Ref, ComputedRef } from 'vue'
import { isNativeCurrencyAddress, isNativeOfWrapped, resolveWrappedNativeAddress, resolveWrappedNativeAsset } from '~/utils/native-currency'
import { logWarn } from '~/utils/errorHandling'
import { createRaceGuard } from '~/utils/race-guard'
import { computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { FixedPoint } from '~/utils/fixed-point'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { getPlanHookDisabledWarning, getUtilisationWarning, getBorrowCapWarning, getSupplyCapWarning } from '~/composables/useVaultWarnings'
import { getVaultTags, isVaultRestrictedByCountry, isAssetBlockedByCountry } from '~/composables/useGeoBlock'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { useStateOverrideOptions } from '~/composables/useStateOverrideOptions'
import { useFreshAccount } from '~/composables/useFreshAccount'

export interface UseBorrowFormOptions {
  pair: Ref<AnyBorrowVaultPair | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  collateralVault: ComputedRef<EVault | undefined>
  formTab: Ref<'borrow' | 'multiply'>

  savingPositions: ComputedRef<PortfolioSavingsPosition<VaultEntity>[]>
  balance: Ref<bigint>

  resolvePendingSubAccount: () => Promise<string>

  collateralSupplyApy: ComputedRef<number>
  borrowApy: ComputedRef<number>
  collateralSupplyRewardApy: ComputedRef<number>
  borrowRewardApy: ComputedRef<number>
  collateralSupplyApyWithRewards: ComputedRef<number>

  isSecuritizeCollateral: ComputedRef<boolean>
  isGeoBlocked: ComputedRef<boolean>
  isBorrowRestricted: ComputedRef<boolean>

  collateralAddress: string
  borrowAddress: string
}

export const useBorrowForm = (options: UseBorrowFormOptions) => {
  const {
    pair,
    borrowVault,
    collateralVault,
    formTab: _formTab,
    savingPositions,
    balance,
    resolvePendingSubAccount,
    collateralSupplyApy,
    borrowApy,
    collateralSupplyRewardApy,
    borrowRewardApy,
    collateralSupplyApyWithRewards,
    isSecuritizeCollateral,
    isGeoBlocked,
    isBorrowRestricted,
    collateralAddress,
    borrowAddress: _borrowAddress,
  } = options

  const modal = useModal()
  const { error } = useToast()
  const { planBorrow, planSwapAndBorrow, executePlan, prefetchPluginData } = useEulerTx()
  const { address, isConnected } = useWagmi()
  const { isSpyMode } = useSpyMode()
  const { chainId } = useEulerAddresses()
  const { fetchSingleBalance } = useWallets()
  const { finalizeTxAndRedirect } = useTxFinalization()
  const { account: freshAccount } = useFreshAccount()
  // Form validates "Not enough balance" up front (see `errorText` / `isSubmitDisabled`),
  // so the simulator never needs to forge wallet balances — `noBalanceOverride: true`
  // skips per-call balanceOf + slot probing. Slot hints + wallet snapshot are still
  // passed so allowance overrides take the same fast path.
  const { primeSlotHintsFor, buildStateOverrideOptions } = useStateOverrideOptions()
  const buildBorrowStateOverrideOptions = () => buildStateOverrideOptions({ noBalanceOverride: true })

  const {
    runSimulation: runBorrowSimulation,
    simulationError: borrowSimulationError,
    clearSimulationError: clearBorrowSimulationError,
  } = useTransactionPlanSimulation()

  const borrowPriceInvert = usePriceInvert(
    () => collateralVault.value?.asset.symbol,
    () => borrowVault.value?.asset.symbol,
  )

  // --- Swap & borrow composable instances ---
  const { slippage: borrowSwapSlippage } = useSlippage({
    fromSymbol: () => collateralVault.value?.asset.symbol,
    toSymbol: () => borrowVault.value?.asset.symbol,
  })
  const {
    sortedQuoteCards: borrowSwapQuoteCards,
    selectedProvider: borrowSwapSelectedProvider,
    selectedQuote: borrowSwapSelectedQuote,
    effectiveQuote: borrowSwapEffectiveQuote,
    effectiveQuoteFetchedAt: borrowSwapEffectiveQuoteFetchedAt,
    isLoading: isBorrowSwapQuoteLoading,
    quoteError: borrowSwapQuoteError,
    statusLabel: borrowSwapQuotesStatusLabel,
    getQuoteDiffPct: getBorrowSwapQuoteDiffPct,
    reset: resetBorrowSwapQuoteState,
    requestQuotes: requestBorrowSwapQuotes,
    selectProvider: selectBorrowSwapQuote,
  } = useSwapQuotesParallel({
    amountField: 'amountOut',
    compare: 'max',
    buildTxPlanForQuote: quote => buildSwapBorrowPlanFromQuote(quote),
    getStateOverrideOptions: () => buildBorrowStateOverrideOptions(),
    // First quote in each sweep resolves the plugin prefetch (Pyth Hermes /
    // keyring vault gating); subsequent quotes reuse it so per-quote prepare
    // skips Hermes pulls and keyring reads.
    prefetchPluginData: (plan, _account) => prefetchPluginData(plan, { account: freshAccount.value }),
  })
  // --- Form state ---
  const ltv = ref(0)
  const borrowAmount = ref('')
  const collateralAmount = ref('')
  const isSavingCollateral = ref(false)
  // Sub-account of the savings position the user picked. Mirrors
  // multiplySelectedSavingSubAccount in useMultiplyForm — the page reads this
  // ref to disambiguate when the user has the same vault as savings on
  // multiple sub-accounts.
  const selectedSavingSubAccount = ref<string | undefined>(undefined)
  const isSubmitting = ref(false)
  const isPreparing = ref(false)
  const isEstimatesLoading = ref(false)
  const plan = ref<TransactionPlan | null>(null)

  const normalizeAddress = (addr?: string) => {
    if (!addr) return ''
    try {
      return getAddress(addr).toLowerCase()
    }
    catch {
      return ''
    }
  }

  const savingCollateral = computed<PortfolioSavingsPosition<VaultEntity> | undefined>(() => {
    const positions = savingPositions.value
    if (!positions.length) return undefined
    const selected = selectedSavingSubAccount.value
    if (selected) {
      return positions.find(position => normalizeAddress(position.subAccount) === normalizeAddress(selected))
    }
    return [...positions].sort((a, b) => (b.assets > a.assets ? 1 : b.assets < a.assets ? -1 : 0))[0]
  })
  const savingAssets = computed(() => savingCollateral.value?.assets || 0n)

  // Estimates
  const health = ref<number | undefined>()
  const netAPY = ref<number | undefined>()
  const liquidationPrice = ref<number | undefined>()

  // Swap state
  const borrowSelectedAsset = ref<VaultAsset | undefined>()
  const borrowSelectedAssetBalance = ref(0n)
  const borrowSwapAssetUsdPrice = ref<number | undefined>()

  // --- Computed: prices ---
  const priceFixed = computed(() => {
    const collateralPrice = borrowVault.value && collateralVault.value
      ? getCollateralOraclePrice(borrowVault.value, collateralVault.value)
      : undefined
    const borrowPrice = borrowVault.value ? getAssetOraclePrice(borrowVault.value) : undefined
    return FixedPoint.fromValue(conservativePriceRatio(collateralPrice, borrowPrice), 18)
  })
  borrowPriceInvert.autoInvert(() => priceFixed.value.toUnsafeFloat())

  const collateralUnitPrice = ref<number | undefined>(undefined)

  watchEffect(async () => {
    if (!borrowVault.value || !collateralVault.value) {
      collateralUnitPrice.value = undefined
      return
    }
    const priceInfo = await getCollateralUsdPrice(borrowVault.value, collateralVault.value as EVault, 'off-chain')
    if (!priceInfo) {
      collateralUnitPrice.value = undefined
      return
    }
    collateralUnitPrice.value = nanoToValue(priceInfo.amountOutMid, 18)
  })

  // Reactive collateral option prices
  const walletCollateralPriceUsd = ref(0)

  watchEffect(async () => {
    if (!collateralVault.value) {
      walletCollateralPriceUsd.value = 0
      return
    }
    walletCollateralPriceUsd.value = await getAssetUsdValueOrZero(balance.value, collateralVault.value, 'off-chain')
  })

  // --- Computed: math ---
  const collateralAmountFixed = computed(() => FixedPoint.fromValue(
    valueToNano(collateralAmount.value || '0', collateralVault.value?.asset.decimals),
    Number(collateralVault.value?.asset.decimals),
  ))
  const borrowAmountFixed = computed(() => FixedPoint.fromValue(
    valueToNano(borrowAmount.value || '0', borrowVault.value?.asset.decimals),
    Number(borrowVault.value?.asset.decimals),
  ))
  const ltvFixed = computed(() => {
    const fn = FixedPoint.fromValue(valueToNano(ltv.value, 4), 4)
    const maxLtv = FixedPoint.fromValue(valueToNano(ltvToPercent(pair.value?.ltv.borrowLTV ?? 0), 4), 4)
    if (fn.gte(maxLtv)) {
      return fn.sub(FixedPoint.fromValue(100n, 4))
    }
    return fn
  })

  // --- Computed: balances ---
  const computedBalance = computed(() => {
    if (isSavingCollateral.value) return savingAssets.value || 0n
    return balance.value
  })

  const borrowNeedsSwap = computed(() => {
    if (!borrowSelectedAsset.value || !collateralVault.value) return false
    // Swap-and-borrow ends with verifyAmountMinAndSkim which calls skim() on the
    // collateral vault — securitize vaults don't implement skim, so the swap
    // path is structurally unsupported here.
    if (isSecuritizeCollateral.value) return false
    try {
      if (isNativeOfWrapped(borrowSelectedAsset.value.address, collateralVault.value.asset.address, chainId.value!)) return false
      return getAddress(borrowSelectedAsset.value.address) !== getAddress(collateralVault.value.asset.address)
    }
    catch {
      return false
    }
  })

  const isBorrowNativeWrap = computed(() => {
    if (!borrowSelectedAsset.value || !collateralVault.value) return false
    return isNativeOfWrapped(borrowSelectedAsset.value.address, collateralVault.value.asset.address, chainId.value!)
  })

  const borrowActiveBalance = computed(() => {
    if (borrowNeedsSwap.value || isBorrowNativeWrap.value) return borrowSelectedAssetBalance.value
    return computedBalance.value
  })

  const borrowActiveAssetDecimals = computed(() => {
    if ((borrowNeedsSwap.value || isBorrowNativeWrap.value) && borrowSelectedAsset.value) return borrowSelectedAsset.value.decimals
    return collateralVault.value?.asset?.decimals
  })

  // --- Computed: swap ---
  const borrowSwapEstimatedCollateral = computed(() => {
    if (!borrowSwapEffectiveQuote.value || !collateralVault.value) return ''
    const amountOut = BigInt(borrowSwapEffectiveQuote.value.amountOut || 0)
    if (amountOut <= 0n) return ''
    return formatUnits(amountOut, Number(collateralVault.value.asset.decimals))
  })

  const effectiveCollateralFixed = computed(() => {
    if (borrowNeedsSwap.value && borrowSwapEffectiveQuote.value && collateralVault.value) {
      const amountOut = BigInt(borrowSwapEffectiveQuote.value.amountOut || 0)
      if (amountOut > 0n) {
        return FixedPoint.fromValue(amountOut, Number(collateralVault.value.asset.decimals))
      }
    }
    return collateralAmountFixed.value
  })

  const borrowSwapInputDisplay = computed(() => {
    if (!borrowSwapEffectiveQuote.value || !borrowSelectedAsset.value) return ''
    const amountIn = BigInt(borrowSwapEffectiveQuote.value.amountIn || 0)
    if (amountIn <= 0n) return ''
    return `${formatSmartAmount(formatUnits(amountIn, Number(borrowSelectedAsset.value.decimals)))} ${borrowSelectedAsset.value.symbol}`
  })

  const borrowSwapInputExactDisplay = computed(() => {
    if (!borrowSwapEffectiveQuote.value || !borrowSelectedAsset.value) return ''
    const amountIn = BigInt(borrowSwapEffectiveQuote.value.amountIn || 0)
    if (amountIn <= 0n) return ''
    return `${formatUnits(amountIn, Number(borrowSelectedAsset.value.decimals))} ${borrowSelectedAsset.value.symbol}`
  })

  const borrowSwapOutputDisplay = computed(() => {
    if (!borrowSwapEffectiveQuote.value || !collateralVault.value) return ''
    const amountOut = BigInt(borrowSwapEffectiveQuote.value.amountOut || 0)
    if (amountOut <= 0n) return ''
    return `${formatSmartAmount(formatUnits(amountOut, Number(collateralVault.value.asset.decimals)))} ${collateralVault.value.asset.symbol}`
  })

  const borrowSwapOutputExactDisplay = computed(() => {
    if (!borrowSwapEffectiveQuote.value || !collateralVault.value) return ''
    const amountOut = BigInt(borrowSwapEffectiveQuote.value.amountOut || 0)
    if (amountOut <= 0n) return ''
    return `${formatUnits(amountOut, Number(collateralVault.value.asset.decimals))} ${collateralVault.value.asset.symbol}`
  })

  const borrowSwapRoutedVia = computed(() => {
    if (!borrowSwapSelectedProvider.value) return 'Not selected'
    if (!borrowSwapEffectiveQuote.value?.route?.length) return null
    return borrowSwapEffectiveQuote.value.route.map((r: { providerName: string }) => r.providerName).join(', ')
  })

  const { priceImpact: borrowSwapPriceImpact } = useSwapPriceImpact({
    quote: borrowSwapEffectiveQuote,
    toVault: collateralVault,
  })

  const borrowSwapRouteItems = computed(() => {
    if (!collateralVault.value) return []
    return buildSwapRouteItems({
      quoteCards: borrowSwapQuoteCards.value,
      getQuoteDiffPct: getBorrowSwapQuoteDiffPct,
      decimals: Number(collateralVault.value.asset.decimals),
      symbol: collateralVault.value.asset.symbol,
      formatAmount: formatSmartAmount,
    })
  })

  // --- Computed: collateral options ---
  const collateralOptions = computed(() => {
    const vaultAddr = collateralVault.value?.address || ''
    const { tags, disabled } = getVaultTags(vaultAddr)
    const decimals = collateralVault.value?.asset.decimals
    const assetAddress = collateralVault.value?.asset.address

    const opts: CollateralOption[] = [
      {
        type: 'wallet',
        amount: nanoToValue(balance.value, decimals),
        price: walletCollateralPriceUsd.value,
        apy: collateralSupplyApyWithRewards.value,
        assetAddress,
        vaultAddress: vaultAddr,
        tags,
        disabled,
      },
    ]

    for (const position of savingPositions.value) {
      const amount = nanoToValue(position.assets, decimals)
      opts.push({
        type: 'saving',
        amount,
        price: collateralUnitPrice.value !== undefined ? amount * collateralUnitPrice.value : 0,
        apy: collateralSupplyApyWithRewards.value,
        assetAddress,
        vaultAddress: position.vault?.address || vaultAddr,
        subAccount: position.subAccount,
        tags,
        disabled,
      })
    }
    return opts
  })

  // --- Computed: validation ---
  const isBorrowSwapRestricted = computed(() =>
    borrowNeedsSwap.value && isVaultRestrictedByCountry(collateralAddress),
  )

  // Pay-with asset can be any ERC-20 not tied to any vault, so the
  // vault-level check above can't see it. Hard-block the asset directly.
  // Soft-restrict does not apply: pay-with reduces exposure to that asset.
  // Pass the asset object so symbol/name pattern rules also apply.
  const isBorrowPayWithBlocked = computed(() =>
    borrowNeedsSwap.value && isAssetBlockedByCountry(borrowSelectedAsset.value),
  )

  const errorText = computed(() => {
    if (borrowActiveBalance.value < valueToNano(collateralAmount.value, borrowActiveAssetDecimals.value)) {
      return 'Not enough balance'
    }
    else if ((borrowVault.value?.availableLiquidity ?? 0n) < valueToNano(borrowAmount.value, borrowVault.value?.asset.decimals)) {
      return 'Not enough liquidity in the vault'
    }
    if (borrowNeedsSwap.value && !borrowSwapQuoteCards.value.length && +collateralAmount.value > 0) {
      return isBorrowSwapQuoteLoading.value ? null : 'No swap quote available'
    }
    if (isSavingCollateral.value && !savingCollateral.value) {
      return 'Savings position not found'
    }
    return null
  })

  const isSupplyCapReached = computed(() => collateralVault.value ? getIsSupplyCapReached(collateralVault.value) : false)
  const isBorrowCapReached = computed(() => borrowVault.value ? getIsBorrowCapReached(borrowVault.value) : false)

  // Which builder runs at submit determines which collateral op the plan touches:
  // swap-and-borrow → buildSwapAndBorrowPlan: only liability OP_BORROW + collateral
  //                   OP_SKIM (via verifier). No deposit/transfer on collateral.
  // savings-sourced → buildBorrowBySavingPlan: collateral OP_TRANSFER + liability OP_BORROW.
  // fresh-deposit   → buildBorrowPlan: collateral OP_DEPOSIT + liability OP_BORROW.
  const borrowPlannedOps = computed<PlannedOp[]>(() => {
    const steps: PlannedOp[] = []
    if (borrowNeedsSwap.value) {
      // Swap-and-borrow: swapper deposits via verifyAmountMinAndSkim (OP_SKIM on collateral)
      if (collateralVault.value) steps.push({ vault: collateralVault.value, op: OP_SKIM })
    }
    else if (collateralVault.value) {
      steps.push({
        vault: collateralVault.value,
        op: isSavingCollateral.value ? OP_TRANSFER : OP_DEPOSIT,
      })
    }
    if (borrowVault.value) steps.push({ vault: borrowVault.value, op: OP_BORROW })
    return steps
  })

  const isSubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (findBlockingDisabledOp(borrowPlannedOps.value)) return true
    if (isSavingCollateral.value && !savingCollateral.value) return true
    if (borrowActiveBalance.value < valueToNano(collateralAmount.value, borrowActiveAssetDecimals.value)) return true
    if (!(+collateralAmount.value)) return true
    if ((borrowVault.value?.availableLiquidity ?? 0n) < valueToNano(borrowAmount.value, borrowVault.value?.asset.decimals)) return true
    if (!valueToNano(borrowAmount.value, borrowVault.value?.asset.decimals)) return true
    if (borrowNeedsSwap.value && !borrowSwapSelectedQuote.value) return true
    if (isSupplyCapReached.value || isBorrowCapReached.value) return true
    return false
  })

  // --- Computed: warnings ---
  const borrowFormWarnings = computed(() => {
    if (!borrowVault.value) return []
    return [
      getPlanHookDisabledWarning(borrowPlannedOps.value),
      getUtilisationWarning(borrowVault.value, 'borrow'),
      getBorrowCapWarning(borrowVault.value),
      collateralVault.value && isEVault(collateralVault.value) ? getSupplyCapWarning(collateralVault.value) : null,
    ]
  })

  // --- Swap quote ---
  const requestBorrowSwapQuote = useDebounceFn(async () => {
    borrowSwapQuoteError.value = null

    if (!borrowSelectedAsset.value || !collateralVault.value || !borrowNeedsSwap.value || !collateralAmount.value) {
      resetBorrowSwapQuoteState()
      return
    }

    const inputAmountNano = valueToNano(collateralAmount.value || '0', borrowSelectedAsset.value.decimals)
    if (inputAmountNano <= 0n) {
      resetBorrowSwapQuoteState()
      return
    }

    const userAddr = (address.value || zeroAddress) as Address
    const subAccountAddr = address.value
      ? (await resolvePendingSubAccount()) as Address
      : userAddr
    const swapTokenIn = isNativeCurrencyAddress(borrowSelectedAsset.value.address)
      ? resolveWrappedNativeAddress(chainId.value!) || borrowSelectedAsset.value.address
      : borrowSelectedAsset.value.address
    await requestBorrowSwapQuotes({
      tokenIn: swapTokenIn as Address,
      tokenOut: collateralVault.value.asset.address as Address,
      accountIn: zeroAddress as Address,
      accountOut: subAccountAddr,
      amount: inputAmountNano,
      vaultIn: zeroAddress as Address,
      receiver: collateralVault.value.address as Address,
      unusedInputReceiver: userAddr,
      slippage: borrowSwapSlippage.value,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      targetDebt: 0n,
      currentDebt: 0n,
    })
  }, 500)

  // --- Actions: swap token selection ---
  const isUnknownBorrowSwapToken = ref(false)

  const onSelectBorrowSwapAsset = (newAsset: VaultAsset, meta?: { isUnknownToken?: boolean }) => {
    borrowSelectedAsset.value = newAsset
    isUnknownBorrowSwapToken.value = meta?.isUnknownToken ?? false
    collateralAmount.value = ''
    clearBorrowSimulationError()
    resetBorrowSwapQuoteState()
  }

  const openBorrowSwapTokenSelector = () => {
    modal.open(SwapTokenSelector, {
      props: {
        currentAssetAddress: borrowSelectedAsset.value?.address || collateralVault.value?.asset.address,
        onSelect: onSelectBorrowSwapAsset,
        allowNativeCurrency: true,
      },
    })
  }

  const onRefreshBorrowSwapQuotes = () => {
    resetBorrowSwapQuoteState()
    requestBorrowSwapQuote()
  }

  // --- Actions: form input handlers ---
  const onCollateralInput = async () => {
    await nextTick()
    borrowAmount.value = trimTrailingZeros(effectiveCollateralFixed.value
      .mul(priceFixed.value)
      .mul(ltvFixed.value)
      .div(FixedPoint.fromValue(100n, 0)).round(Number(borrowVault.value?.asset.decimals || 18))
      .toString())
  }

  const onBorrowInput = async () => {
    await nextTick()
    if (!collateralAmount.value) {
      return
    }
    const collateral = effectiveCollateralFixed.value
    if (collateral.isZero()) return
    ltv.value = +borrowAmountFixed.value
      .div(collateral.mul(priceFixed.value))
      .mul(FixedPoint.fromValue(100n, 0))
      .toUnsafeFloat().toFixed(2)
  }

  const onLtvInput = async () => {
    await nextTick()
    onCollateralInput()
  }

  const onChangeCollateral = (selection: boolean | number) => {
    clearBorrowSimulationError()
    if (typeof selection === 'number') {
      const option = collateralOptions.value[selection]
      const nextIsSaving = option?.type === 'saving'
      isSavingCollateral.value = nextIsSaving
      selectedSavingSubAccount.value = nextIsSaving ? option?.subAccount : undefined
      return
    }
    isSavingCollateral.value = selection
    if (!selection) selectedSavingSubAccount.value = undefined
  }

  // --- Actions: estimates ---

  // Synchronous estimates (health, liq price) update instantly on every input
  const updateSyncEstimates = () => {
    if (!pair.value) return
    try {
      health.value = computeNextHealth(
        ltvToPercent(pair.value.ltv.liquidationLTV),
        ltvFixed.value.toUnsafeFloat(),
      ) ?? Infinity
      liquidationPrice.value = computeLiquidationPrice(
        priceFixed.value.toUnsafeFloat(),
        health.value,
      ) ?? undefined
    }
    catch (e) {
      logWarn('borrow/syncEstimates', e)
      health.value = undefined
      liquidationPrice.value = undefined
    }
  }

  // Async estimates (projected rates, USD prices, net APY) are debounced
  const asyncEstimatesGuard = createRaceGuard()
  const updateAsyncEstimates = useDebounceFn(async () => {
    if (!pair.value || !collateralVault.value || !borrowVault.value) return
    const gen = asyncEstimatesGuard.next()
    try {
      // When swapping, use the quote output amount (collateral-vault-asset denominated)
      const collateralAmountNano = borrowNeedsSwap.value
        ? borrowSwapEffectiveQuote.value ? BigInt(borrowSwapEffectiveQuote.value.amountOut || 0) : 0n
        : valueToNano(collateralAmount.value || '0', collateralVault.value.shares.decimals)
      const borrowAmountNano = valueToNano(borrowAmount.value || '0', borrowVault.value.shares.decimals)

      const [collateralProjected, borrowProjected, collateralUsdValue, borrowUsdValue] = await Promise.all([
        getProjectedRates(
          collateralVault.value.address,
          collateralVault.value.totalCash,
          collateralVault.value.totalBorrowed,
          collateralAmountNano,
          0n,
        ),
        getProjectedRates(
          borrowVault.value.address,
          borrowVault.value.totalCash,
          borrowVault.value.totalBorrowed,
          -borrowAmountNano,
          borrowAmountNano,
        ),
        borrowNeedsSwap.value && borrowSwapAssetUsdPrice.value
          ? Promise.resolve((+collateralAmount.value || 0) * borrowSwapAssetUsdPrice.value)
          : getAssetUsdValueOrZero(collateralAmountNano, collateralVault.value!, 'off-chain'),
        getAssetUsdValueOrZero(borrowAmountNano, borrowVault.value!, 'off-chain'),
      ])

      if (asyncEstimatesGuard.isStale(gen)) return

      // Apply projected rate deltas on top of current APYs (which include intrinsic APY)
      const projectedSupplyApy = collateralProjected
        ? collateralSupplyApy.value + (nanoToValue(collateralProjected.supplyAPY, 25) - getVaultSupplyApy(collateralVault.value))
        : collateralSupplyApy.value

      const projectedBorrowApy = borrowProjected
        ? borrowApy.value + (nanoToValue(borrowProjected.borrowAPY, 25) - getVaultBorrowApy(borrowVault.value))
        : borrowApy.value

      netAPY.value = getNetAPY(
        collateralUsdValue,
        projectedSupplyApy,
        borrowUsdValue,
        projectedBorrowApy,
        collateralSupplyRewardApy.value || null,
        borrowRewardApy.value || null,
      )
    }
    catch (e) {
      if (asyncEstimatesGuard.isStale(gen)) return
      logWarn('borrow/asyncEstimates', e)
      netAPY.value = undefined
    }
    finally {
      if (!asyncEstimatesGuard.isStale(gen)) {
        isEstimatesLoading.value = false
      }
    }
  }, 500)

  // --- Actions: submit & send ---
  const buildSwapBorrowPlanFromQuote = async (quote: SwapQuote): Promise<TransactionPlan> => {
    if (!borrowSelectedAsset.value || !collateralVault.value || !borrowVault.value) {
      throw new Error('Missing vault or asset data')
    }
    const isNative = isNativeCurrencyAddress(borrowSelectedAsset.value.address)
    const inputAmount = valueToNano(collateralAmount.value || '0', borrowSelectedAsset.value.decimals)
    const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
    if (isNative && !wrappedAddress) {
      throw new Error('Wrapped native token not found')
    }
    const borrowAmountNano = valueToNano(borrowAmount.value || '0', borrowVault.value.shares.decimals)
    const subAccount = await resolvePendingSubAccount()
    return planSwapAndBorrow({
      swapQuote: quote,
      amount: inputAmount,
      tokenIn: (wrappedAddress || borrowSelectedAsset.value.address) as Address,
      collateralVault: collateralVault.value.address as Address,
      borrowVault: borrowVault.value.address as Address,
      borrowAmount: borrowAmountNano,
      borrowAccount: subAccount as Address,
      wrappedNativeInfo: isNative && wrappedAddress
        ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
        : undefined,
    })
  }

  const submit = async () => {
    if (isOperationBlocked.value) return
    if (isPreparing.value || isGeoBlocked.value || isBorrowRestricted.value || isBorrowSwapRestricted.value || isBorrowPayWithBlocked.value) return
    isPreparing.value = true
    try {
      if (!isConnected.value) {
        isSubmitting.value = false
        return
      }

      if (!borrowVault.value || !collateralVault.value) {
        return
      }

      // Swap & borrow path
      if (borrowNeedsSwap.value && borrowSwapEffectiveQuote.value) {
        try {
          plan.value = await buildSwapBorrowPlanFromQuote(borrowSwapEffectiveQuote.value)
        }
        catch (e) {
          logWarn('borrow/buildSwapPlan', e)
          plan.value = null
        }

        if (plan.value) {
          const ok = await runBorrowSimulation(plan.value, buildBorrowStateOverrideOptions())
          if (!ok) {
            return
          }
        }

        const isNativeSwap = borrowSelectedAsset.value && isNativeCurrencyAddress(borrowSelectedAsset.value.address)
        const reviewAsset = isNativeSwap
          ? (resolveWrappedNativeAsset(chainId.value!) || borrowSelectedAsset.value!)
          : (borrowSelectedAsset.value || collateralVault.value.asset)
        modal.open(OperationReviewModal, {
          props: {
            type: 'swap-borrow' as const,
            asset: reviewAsset,
            amount: collateralAmount.value,
            plan: plan.value || undefined,
            quoteFetchedAt: borrowSwapEffectiveQuoteFetchedAt.value,
            swapToAsset: collateralVault.value.asset,
            swapToAmount: borrowSwapEstimatedCollateral.value,
            swapMode: SwapperMode.EXACT_IN,
            onConfirm: async () => {
              await send()
            },
            submittingLabel: 'Submitting...',
          },
        })
        return
      }

      // Standard borrow path
      const collateralAmountNano = valueToNano(collateralAmount.value || '0', collateralVault.value?.asset.decimals)
      const borrowAmountNano = valueToNano(borrowAmount.value || '0', borrowVault.value?.asset.decimals)
      let collateralAmountForPlan = collateralAmountNano
      let selectedSavingsCollateral: PortfolioSavingsPosition<VaultEntity> | undefined

      if (isSavingCollateral.value) {
        selectedSavingsCollateral = savingCollateral.value
        if (!selectedSavingsCollateral) {
          plan.value = null
          return
        }
        if (selectedSavingsCollateral.assets === collateralAmountNano) {
          collateralAmountForPlan = selectedSavingsCollateral.shares
        }
        else {
          collateralAmountForPlan = collateralVault.value.convertToShares(collateralAmountNano)
        }
      }

      try {
        const subAccountAddr = (await resolvePendingSubAccount()) as Address
        plan.value = isSavingCollateral.value
          ? await planBorrow({
              vaultAddress: borrowVault.value.address as Address,
              amount: borrowAmountNano,
              borrowAccount: subAccountAddr,
              collateral: {
                vault: collateralVault.value.address as Address,
                amount: collateralAmountForPlan,
                source: 'savings',
                from: selectedSavingsCollateral!.subAccount as Address,
              },
            })
          : await planBorrow({
              vaultAddress: borrowVault.value.address as Address,
              amount: borrowAmountNano,
              borrowAccount: subAccountAddr,
              collateral: {
                vault: collateralVault.value.address as Address,
                asset: collateralVault.value.asset.address as Address,
                amount: collateralAmountForPlan,
                wrappedNativeInfo: isBorrowNativeWrap.value
                  ? { wrappedTokenAddress: resolveWrappedNativeAddress(chainId.value!)!, nativeAmount: collateralAmountForPlan }
                  : undefined,
              },
            })
      }
      catch (e) {
        logWarn('borrow/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runBorrowSimulation(plan.value, buildBorrowStateOverrideOptions())
        if (!ok) {
          return
        }
      }

      modal.open(OperationReviewModal, {
        props: {
          type: 'borrow',
          asset: borrowVault.value?.asset,
          amount: borrowAmount.value,
          plan: plan.value || undefined,
          supplyingAssetForBorrow: collateralVault.value?.asset,
          supplyingAmount: collateralAmount.value,
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
      if (!collateralVault.value || !borrowVault.value) {
        return
      }

      let txPlan: TransactionPlan

      // Swap & borrow path
      if (borrowNeedsSwap.value) {
        const quote = borrowSwapSelectedQuote.value || borrowSwapEffectiveQuote.value
        if (!quote) {
          error('No swap quote available')
          return
        }
        txPlan = await buildSwapBorrowPlanFromQuote(quote)
      }
      else {
        // Standard borrow path
        let collateralAmountForPlan = collateralAmountFixed.value.toFormat({ decimals: Number(collateralVault.value.shares.decimals) }).value
        let selectedSavingsCollateral: PortfolioSavingsPosition<VaultEntity> | undefined
        if (isSavingCollateral.value) {
          selectedSavingsCollateral = savingCollateral.value
          if (!selectedSavingsCollateral) {
            throw new Error('Savings position not found')
          }
          if (selectedSavingsCollateral.assets === collateralAmountForPlan) {
            collateralAmountForPlan = selectedSavingsCollateral.shares
          }
          else {
            collateralAmountForPlan = collateralVault.value.convertToShares(collateralAmountForPlan)
          }
        }
        const borrowAmountNano = borrowAmountFixed.value.toFormat({ decimals: Number(borrowVault.value.shares.decimals) }).value
        const subAccountAddr = (await resolvePendingSubAccount()) as Address
        txPlan = isSavingCollateral.value
          ? await planBorrow({
              vaultAddress: borrowVault.value.address as Address,
              amount: borrowAmountNano,
              borrowAccount: subAccountAddr,
              collateral: {
                vault: collateralVault.value.address as Address,
                amount: collateralAmountForPlan,
                source: 'savings',
                from: selectedSavingsCollateral!.subAccount as Address,
              },
            })
          : await planBorrow({
              vaultAddress: borrowVault.value.address as Address,
              amount: borrowAmountNano,
              borrowAccount: subAccountAddr,
              collateral: {
                vault: collateralVault.value.address as Address,
                asset: collateralVault.value.asset.address as Address,
                amount: collateralAmountForPlan,
                wrappedNativeInfo: isBorrowNativeWrap.value
                  ? { wrappedTokenAddress: resolveWrappedNativeAddress(chainId.value!)!, nativeAmount: collateralAmountForPlan }
                  : undefined,
              },
            })
      }
      await executePlan(txPlan)
      await finalizeTxAndRedirect()
    }
    catch (e) {
      logWarn('borrow/send', e)
      error('Transaction failed')
    }
    finally {
      isSubmitting.value = false
    }
  }

  // --- Actions: balance ---
  const updateBorrowSwapAssetBalance = async () => {
    if (borrowSelectedAsset.value?.address && (isConnected.value || isSpyMode.value)) {
      borrowSelectedAssetBalance.value = await fetchSingleBalance(borrowSelectedAsset.value.address)
    }
    else {
      borrowSelectedAssetBalance.value = 0n
    }
  }

  // Pre-prime slot hints for assets this form touches (collateral, borrow,
  // selected pay-with token). Hits run once per token; the SDK module-scope
  // cache keeps subsequent prepares/estimates free of access-list discovery.
  watch(
    [collateralVault, borrowVault, borrowSelectedAsset],
    ([collateral, borrow, selected]) => {
      const tokens: Address[] = []
      const seen = new Set<string>()
      const push = (addr?: string) => {
        if (!addr || isNativeCurrencyAddress(addr)) return
        const key = addr.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        tokens.push(addr as Address)
      }
      push(collateral?.asset?.address)
      push(borrow?.asset?.address)
      push(selected?.address)
      if (tokens.length) void primeSlotHintsFor(tokens)
    },
    { immediate: true },
  )

  // --- Watchers ---
  watch([collateralAmount, borrowAmount], () => {
    clearBorrowSimulationError()
    if (!pair.value) {
      return
    }
    updateSyncEstimates()
    if (!isEstimatesLoading.value) {
      isEstimatesLoading.value = true
    }
    updateAsyncEstimates()
  })

  watch(borrowSelectedAsset, async () => {
    if (borrowSelectedAsset.value?.address && (isConnected.value || isSpyMode.value)) {
      borrowSelectedAssetBalance.value = await fetchSingleBalance(borrowSelectedAsset.value.address)
    }
    else {
      borrowSelectedAssetBalance.value = 0n
    }
    if (borrowNeedsSwap.value && collateralAmount.value) {
      resetBorrowSwapQuoteState()
      if (+collateralAmount.value > 0) {
        isBorrowSwapQuoteLoading.value = true
      }
      requestBorrowSwapQuote()
    }
    if (borrowSelectedAsset.value?.address && borrowNeedsSwap.value) {
      const priceAddr = isNativeCurrencyAddress(borrowSelectedAsset.value.address)
        ? resolveWrappedNativeAddress(chainId.value!) || borrowSelectedAsset.value.address
        : borrowSelectedAsset.value.address
      borrowSwapAssetUsdPrice.value = await getTokenUsdPrice(priceAddr as Address)
    }
    else {
      borrowSwapAssetUsdPrice.value = undefined
    }
  })

  watch(collateralAmount, () => {
    if (borrowNeedsSwap.value) {
      resetBorrowSwapQuoteState()
      if (+collateralAmount.value > 0) {
        isBorrowSwapQuoteLoading.value = true
      }
      requestBorrowSwapQuote()
    }
  })

  watch(borrowSwapSlippage, () => {
    if (borrowNeedsSwap.value && collateralAmount.value) {
      clearBorrowSimulationError()
      resetBorrowSwapQuoteState()
      if (+collateralAmount.value > 0) {
        isBorrowSwapQuoteLoading.value = true
      }
      requestBorrowSwapQuote()
    }
  })

  watch(borrowSwapEffectiveQuote, () => {
    if (borrowNeedsSwap.value && collateralAmount.value && +ltv.value > 0) {
      onCollateralInput()
    }
    // Re-run projected rate estimates when quote resolves — collateralAmountNano depends on amountOut
    if (borrowNeedsSwap.value) {
      if (borrowSwapEffectiveQuote.value) {
        if (!isEstimatesLoading.value) isEstimatesLoading.value = true
        updateAsyncEstimates()
      }
      else {
        isEstimatesLoading.value = true
        updateAsyncEstimates()
      }
    }
  })

  watch(borrowSwapSelectedQuote, () => {
    clearBorrowSimulationError()
  })

  // --- Reset ---
  const resetOnTabSwitch = () => {
    clearBorrowSimulationError()
  }

  return {
    // Form state
    ltv,
    borrowAmount,
    collateralAmount,
    isSavingCollateral,
    selectedSavingSubAccount,
    savingCollateral,
    savingAssets,
    isSubmitting,
    isPreparing,
    isEstimatesLoading,
    plan,

    // Estimates
    health,
    netAPY,
    liquidationPrice,

    // Computed: math
    collateralAmountFixed,
    borrowAmountFixed,
    ltvFixed,
    priceFixed,

    // Computed: balances
    computedBalance,
    borrowActiveBalance,
    borrowActiveAssetDecimals,
    borrowNeedsSwap,

    // Computed: collateral options
    collateralOptions,

    // Computed: validation
    errorText,
    isSubmitDisabled,
    isBorrowSwapRestricted,
    isBorrowPayWithBlocked,

    // Computed: warnings
    borrowFormWarnings,

    // Computed: swap
    borrowSwapEstimatedCollateral,
    borrowSwapInputDisplay,
    borrowSwapInputExactDisplay,
    borrowSwapOutputDisplay,
    borrowSwapOutputExactDisplay,
    borrowSwapRoutedVia,
    borrowSwapPriceImpact,
    borrowSwapRouteItems,

    // Swap state
    borrowSelectedAsset,
    borrowSelectedAssetBalance,
    borrowSwapAssetUsdPrice,
    borrowSwapSlippage,
    borrowSwapSelectedProvider,
    borrowSwapQuoteCards,
    isBorrowSwapQuoteLoading,
    borrowSwapQuoteError,
    borrowSwapQuotesStatusLabel,
    borrowSwapEffectiveQuote,
    selectBorrowSwapQuote,

    // Unknown token warning
    isUnknownBorrowSwapToken,

    // Display
    collateralUnitPrice,
    borrowPriceInvert,
    borrowSimulationError,

    // Actions
    onCollateralInput,
    onBorrowInput,
    onLtvInput,
    onChangeCollateral,
    openBorrowSwapTokenSelector,
    onSelectBorrowSwapAsset,
    onRefreshBorrowSwapQuotes,
    submit,
    send,
    updateEstimates: () => {
      updateSyncEstimates()
      updateAsyncEstimates()
    },
    updateBorrowSwapAssetBalance,
    resetOnTabSwitch,
  }
}
