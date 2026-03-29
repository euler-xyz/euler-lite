import type { Ref, ComputedRef } from 'vue'
import { useAccount } from '@wagmi/vue'
import { getAddress, formatUnits, zeroAddress, type Address } from 'viem'
import { isNativeCurrencyAddress, isNativeOfWrapped, resolveWrappedNativeAddress, resolveWrappedNativeAsset } from '~/utils/native-currency'
import { logWarn } from '~/utils/errorHandling'
import { computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { FixedPoint } from '~/utils/fixed-point'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal, SwapTokenSelector } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import {
  type AnyBorrowVaultPair,
  type VaultAsset,
  type CollateralOption,
  type Vault,
  convertAssetsToShares,
} from '~/entities/vault'
import {
  getAssetUsdValueOrZero,
  getAssetOraclePrice,
  getCollateralOraclePrice,
  getCollateralUsdPrice,
  conservativePriceRatio,
} from '~/services/pricing/priceProvider'
import { fetchBackendPrice } from '~/services/pricing/backendClient'
import { type SwapApiQuote, SwapperMode } from '~/entities/swap'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import type { TxPlan } from '~/entities/txPlan'
import { getUtilisationWarning, getBorrowCapWarning, getSupplyCapWarning } from '~/composables/useVaultWarnings'
import { getVaultTags, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { getNetAPY, getProjectedRates } from '~/entities/vault'

export interface UseBorrowFormOptions {
  pair: Ref<AnyBorrowVaultPair | undefined>
  borrowVault: ComputedRef<Vault | undefined>
  collateralVault: ComputedRef<Vault | undefined>
  formTab: Ref<'borrow' | 'multiply'>

  savingCollateral: ComputedRef<{ assets: bigint, subAccount?: string, shares: bigint } | undefined>
  balance: Ref<bigint>
  savingBalance: Ref<bigint>
  savingAssets: Ref<bigint>

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
    savingCollateral,
    balance,
    savingBalance,
    savingAssets,
    resolvePendingSubAccount,
    collateralSupplyApy,
    borrowApy,
    collateralSupplyRewardApy,
    borrowRewardApy,
    collateralSupplyApyWithRewards,
    isSecuritizeCollateral: _isSecuritizeCollateral,
    isGeoBlocked,
    isBorrowRestricted,
    collateralAddress,
    borrowAddress: _borrowAddress,
  } = options

  const router = useRouter()
  const modal = useModal()
  const { error } = useToast()
  const { buildBorrowPlan, buildBorrowBySavingPlan, buildSwapAndBorrowPlan, executeTxPlan } = useEulerOperations()
  const { address, isConnected } = useAccount()
  const { refreshAllPositions } = useEulerAccount()
  const { eulerLensAddresses, chainId } = useEulerAddresses()
  const { fetchSingleBalance } = useWallets()

  const {
    runSimulation: runBorrowSimulation,
    simulationError: borrowSimulationError,
    clearSimulationError: clearBorrowSimulationError,
  } = useTxPlanSimulation()

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
    isLoading: isBorrowSwapQuoteLoading,
    quoteError: borrowSwapQuoteError,
    statusLabel: borrowSwapQuotesStatusLabel,
    getQuoteDiffPct: getBorrowSwapQuoteDiffPct,
    reset: resetBorrowSwapQuoteState,
    requestQuotes: requestBorrowSwapQuotes,
    selectProvider: selectBorrowSwapQuote,
  } = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max' })

  // --- Form state ---
  const ltv = ref(0)
  const borrowAmount = ref('')
  const collateralAmount = ref('')
  const isSavingCollateral = ref(false)
  const isSubmitting = ref(false)
  const isPreparing = ref(false)
  const isEstimatesLoading = ref(false)
  const plan = ref<TxPlan | null>(null)

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
    const priceInfo = await getCollateralUsdPrice(borrowVault.value, collateralVault.value as Vault, 'off-chain')
    if (!priceInfo) {
      collateralUnitPrice.value = undefined
      return
    }
    collateralUnitPrice.value = nanoToValue(priceInfo.amountOutMid, 18)
  })

  // Reactive collateral option prices
  const walletCollateralPriceUsd = ref(0)
  const savingCollateralPriceUsd = ref(0)

  watchEffect(async () => {
    if (!collateralVault.value) {
      walletCollateralPriceUsd.value = 0
      savingCollateralPriceUsd.value = 0
      return
    }
    walletCollateralPriceUsd.value = await getAssetUsdValueOrZero(balance.value, collateralVault.value, 'off-chain')
    if (savingCollateral.value) {
      savingCollateralPriceUsd.value = await getAssetUsdValueOrZero(savingCollateral.value.assets, collateralVault.value, 'off-chain')
    }
    else {
      savingCollateralPriceUsd.value = 0
    }
  })

  // --- Computed: math ---
  const collateralAmountFixed = computed(() => FixedPoint.fromValue(
    valueToNano(collateralAmount.value || '0', collateralVault.value?.decimals),
    Number(collateralVault.value?.decimals),
  ))
  const borrowAmountFixed = computed(() => FixedPoint.fromValue(
    valueToNano(borrowAmount.value || '0', borrowVault.value?.decimals),
    Number(borrowVault.value?.decimals),
  ))
  const ltvFixed = computed(() => {
    const fn = FixedPoint.fromValue(valueToNano(ltv.value, 4), 4)
    if (fn.gte(FixedPoint.fromValue(pair.value?.borrowLTV || 0n, 2))) {
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

  const borrowSwapOutputDisplay = computed(() => {
    if (!borrowSwapEffectiveQuote.value || !collateralVault.value) return ''
    const amountOut = BigInt(borrowSwapEffectiveQuote.value.amountOut || 0)
    if (amountOut <= 0n) return ''
    return `${formatSmartAmount(formatUnits(amountOut, Number(collateralVault.value.asset.decimals)))} ${collateralVault.value.asset.symbol}`
  })

  const borrowSwapRoutedVia = computed(() => {
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

    const opts: CollateralOption[] = [
      {
        type: 'wallet',
        amount: nanoToValue(balance.value, collateralVault.value?.asset.decimals),
        price: walletCollateralPriceUsd.value,
        apy: collateralSupplyApyWithRewards.value,
        assetAddress: collateralVault.value?.asset.address,
        tags,
        disabled,
      },
    ]

    if (savingCollateral.value) {
      opts.push({
        type: 'saving',
        amount: nanoToValue(savingCollateral.value.assets, collateralVault.value?.asset.decimals),
        price: savingCollateralPriceUsd.value,
        apy: collateralSupplyApyWithRewards.value,
        assetAddress: collateralVault.value?.asset.address,
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

  const errorText = computed(() => {
    if (borrowActiveBalance.value < valueToNano(collateralAmount.value, borrowActiveAssetDecimals.value)) {
      return 'Not enough balance'
    }
    else if ((borrowVault.value?.supply || 0n) < valueToNano(borrowAmount.value, borrowVault.value?.decimals)) {
      return 'Not enough liquidity in the vault'
    }
    if (borrowNeedsSwap.value && !borrowSwapSelectedQuote.value && +collateralAmount.value > 0) {
      return isBorrowSwapQuoteLoading.value ? null : 'No swap quote available'
    }
    return null
  })

  const isSupplyCapReached = computed(() => collateralVault.value ? getIsSupplyCapReached(collateralVault.value) : false)
  const isBorrowCapReached = computed(() => borrowVault.value ? getIsBorrowCapReached(borrowVault.value) : false)

  const isSubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (borrowActiveBalance.value < valueToNano(collateralAmount.value, borrowActiveAssetDecimals.value)) return true
    if (!(+collateralAmount.value)) return true
    if ((borrowVault.value?.supply || 0n) < valueToNano(borrowAmount.value, borrowVault.value?.decimals)) return true
    if (!valueToNano(borrowAmount.value, borrowVault.value?.decimals)) return true
    if (borrowNeedsSwap.value && !borrowSwapSelectedQuote.value) return true
    if (isSupplyCapReached.value || isBorrowCapReached.value) return true
    return false
  })

  // --- Computed: warnings ---
  const borrowFormWarnings = computed(() => {
    if (!borrowVault.value) return []
    return [
      getUtilisationWarning(borrowVault.value, 'borrow'),
      getBorrowCapWarning(borrowVault.value),
      collateralVault.value && !('type' in collateralVault.value) ? getSupplyCapWarning(collateralVault.value) : null,
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
    }, {
      logContext: {
        tokenIn: borrowSelectedAsset.value.address,
        tokenOut: collateralVault.value.asset.address,
        amount: collateralAmount.value,
        slippage: borrowSwapSlippage.value,
      },
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
      .div(FixedPoint.fromValue(100n, 0)).round(Number(borrowVault.value?.decimals || 18))
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
      isSavingCollateral.value = selection === 1
      return
    }
    isSavingCollateral.value = selection
  }

  // --- Actions: estimates ---

  // Synchronous estimates (health, liq price) update instantly on every input
  const updateSyncEstimates = () => {
    if (!pair.value) return
    try {
      health.value = computeNextHealth(
        Number(pair.value?.liquidationLTV || 0n) / 100,
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
  const updateAsyncEstimates = useDebounceFn(async () => {
    if (!pair.value || !collateralVault.value || !borrowVault.value) return
    try {
      const collateralAmountNano = valueToNano(collateralAmount.value || '0', collateralVault.value.decimals)
      const borrowAmountNano = valueToNano(borrowAmount.value || '0', borrowVault.value.decimals)

      const [collateralProjected, borrowProjected, collateralUsdValue, borrowUsdValue] = await Promise.all([
        getProjectedRates(
          collateralVault.value.address,
          collateralVault.value.interestRateInfo.cash,
          collateralVault.value.interestRateInfo.borrows,
          collateralAmountNano,
          0n,
        ),
        getProjectedRates(
          borrowVault.value.address,
          borrowVault.value.interestRateInfo.cash,
          borrowVault.value.interestRateInfo.borrows,
          -borrowAmountNano,
          borrowAmountNano,
        ),
        borrowNeedsSwap.value && borrowSwapAssetUsdPrice.value
          ? Promise.resolve((+collateralAmount.value || 0) * borrowSwapAssetUsdPrice.value)
          : getAssetUsdValueOrZero(+collateralAmount.value || 0, collateralVault.value!, 'off-chain'),
        getAssetUsdValueOrZero(+borrowAmount.value || 0, borrowVault.value!, 'off-chain'),
      ])

      // Apply projected rate deltas on top of current APYs (which include intrinsic APY)
      const currentRawSupplyApy = nanoToValue(collateralVault.value.interestRateInfo.supplyAPY, 25)
      const projectedRawSupplyApy = nanoToValue(collateralProjected.supplyAPY, 25)
      const projectedSupplyApy = collateralSupplyApy.value + (projectedRawSupplyApy - currentRawSupplyApy)

      const currentRawBorrowApy = nanoToValue(borrowVault.value.interestRateInfo.borrowAPY, 25)
      const projectedRawBorrowApy = nanoToValue(borrowProjected.borrowAPY, 25)
      const projectedBorrowApy = borrowApy.value + (projectedRawBorrowApy - currentRawBorrowApy)

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
      logWarn('borrow/asyncEstimates', e)
      netAPY.value = undefined
    }
    finally {
      isEstimatesLoading.value = false
    }
  }, 500)

  // --- Actions: submit & send ---
  const buildSwapBorrowPlanFromQuote = async (quote: SwapApiQuote, planOptions: { includePermit2Call?: boolean } = {}): Promise<TxPlan> => {
    if (!borrowSelectedAsset.value || !collateralVault.value || !borrowVault.value) {
      throw new Error('Missing vault or asset data')
    }
    const isNative = isNativeCurrencyAddress(borrowSelectedAsset.value.address)
    const inputAmount = valueToNano(collateralAmount.value || '0', borrowSelectedAsset.value.decimals)
    const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
    if (isNative && !wrappedAddress) {
      throw new Error('Wrapped native token not found')
    }
    const borrowAmountNano = valueToNano(borrowAmount.value || '0', borrowVault.value.decimals)
    const subAccount = await resolvePendingSubAccount()
    return buildSwapAndBorrowPlan({
      inputTokenAddress: (wrappedAddress || borrowSelectedAsset.value.address) as Address,
      inputAmount,
      collateralVaultAddress: collateralVault.value.address as Address,
      borrowVaultAddress: borrowVault.value.address as Address,
      borrowAmount: borrowAmountNano,
      swapQuote: quote,
      subAccount,
      includePermit2Call: planOptions.includePermit2Call,
      wrappedNativeInfo: isNative && wrappedAddress
        ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
        : undefined,
    })
  }

  const submit = async () => {
    if (isOperationBlocked.value) return
    if (isPreparing.value || isGeoBlocked.value || isBorrowRestricted.value || isBorrowSwapRestricted.value) return
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
          plan.value = await buildSwapBorrowPlanFromQuote(borrowSwapEffectiveQuote.value, { includePermit2Call: false })
        }
        catch (e) {
          logWarn('borrow/buildSwapPlan', e)
          plan.value = null
        }

        if (plan.value) {
          const ok = await runBorrowSimulation(plan.value)
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
            swapToAsset: collateralVault.value.asset,
            swapToAmount: borrowSwapEstimatedCollateral.value,
            onConfirm: () => {
              setTimeout(() => {
                send()
              }, 400)
            },
          },
        })
        return
      }

      // Standard borrow path
      const collateralAmountNano = valueToNano(collateralAmount.value || '0', collateralVault.value?.decimals)
      const borrowAmountNano = valueToNano(borrowAmount.value || '0', borrowVault.value?.decimals)
      let collateralAmountForPlan = collateralAmountNano

      if (isSavingCollateral.value) {
        if (savingCollateral.value?.assets === collateralAmountNano) {
          collateralAmountForPlan = savingBalance.value
        }
        else {
          collateralAmountForPlan = await convertAssetsToShares(collateralVault.value.address, collateralAmountNano)
        }
      }

      try {
        plan.value = isSavingCollateral.value
          ? await buildBorrowBySavingPlan(
            collateralVault.value.address,
            collateralAmountForPlan,
            borrowVault.value.address,
            borrowAmountNano,
            undefined,
            undefined,
            savingCollateral.value?.subAccount,
          )
          : await buildBorrowPlan(
            collateralVault.value.address,
            collateralVault.value.asset.address,
            collateralAmountForPlan,
            borrowVault.value.address,
            borrowAmountNano,
            undefined,
            {
              includePermit2Call: false,
              wrappedNativeInfo: isBorrowNativeWrap.value
                ? { wrappedTokenAddress: resolveWrappedNativeAddress(chainId.value!)!, nativeAmount: collateralAmountForPlan }
                : undefined,
            },
          )
      }
      catch (e) {
        logWarn('borrow/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runBorrowSimulation(plan.value)
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
          onConfirm: () => {
            setTimeout(() => {
              send()
            }, 400)
          },
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

      let txPlan: TxPlan

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
        let collateralAmountForPlan = collateralAmountFixed.value.toFormat({ decimals: Number(collateralVault.value.decimals) }).value
        if (isSavingCollateral.value) {
          if (savingCollateral.value?.assets === collateralAmountForPlan) {
            collateralAmountForPlan = savingBalance.value
          }
          else {
            collateralAmountForPlan = await convertAssetsToShares(collateralVault.value.address, collateralAmountForPlan)
          }
        }
        const borrowAmountNano = borrowAmountFixed.value.toFormat({ decimals: Number(borrowVault.value.decimals) }).value
        txPlan = isSavingCollateral.value
          ? await buildBorrowBySavingPlan(
            collateralVault.value.address,
            collateralAmountForPlan,
            borrowVault.value.address,
            borrowAmountNano,
            undefined,
            undefined,
            savingCollateral.value?.subAccount,
          )
          : await buildBorrowPlan(
            collateralVault.value.address,
            collateralVault.value.asset.address,
            collateralAmountForPlan,
            borrowVault.value.address,
            borrowAmountNano,
            undefined,
            {
              includePermit2Call: true,
              wrappedNativeInfo: isBorrowNativeWrap.value
                ? { wrappedTokenAddress: resolveWrappedNativeAddress(chainId.value!)!, nativeAmount: collateralAmountForPlan }
                : undefined,
            },
          )
      }
      await executeTxPlan(txPlan)

      modal.close()
      refreshAllPositions(eulerLensAddresses.value, address.value || '')
      setTimeout(() => {
        router.replace('/portfolio')
      }, 400)
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
    if (borrowSelectedAsset.value?.address && isConnected.value) {
      borrowSelectedAssetBalance.value = await fetchSingleBalance(borrowSelectedAsset.value.address)
    }
    else {
      borrowSelectedAssetBalance.value = 0n
    }
  }

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

  watch(savingCollateral, (val) => {
    if (val?.assets && !savingAssets.value) {
      savingAssets.value = val.assets
    }
  })

  watch(borrowSelectedAsset, async () => {
    if (borrowSelectedAsset.value?.address && isConnected.value) {
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
      const priceData = await fetchBackendPrice(priceAddr as Address)
      borrowSwapAssetUsdPrice.value = priceData?.price
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

    // Computed: warnings
    borrowFormWarnings,

    // Computed: swap
    borrowSwapEstimatedCollateral,
    borrowSwapInputDisplay,
    borrowSwapOutputDisplay,
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
