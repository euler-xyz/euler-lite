import type { VaultAsset } from '~/types/asset'
import type { CollateralOption } from '~/types/collateral-option'
import { isEVault, type Account, type EVault, type IHasVaultAddress, type PortfolioSavingsPosition, type TransactionPlan, SwapperMode, type SwapQuote, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { areProjectedRatesComplete, getProjectedRatesBatch, getPositionMultiplier, type ProjectedRates, type ProjectedRatesRequest } from '~/utils/vault/apy'
import { withProjectedVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { findBlockingDisabledOp, OP_BORROW, OP_DEPOSIT, OP_SKIM, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { getCollateralOraclePrice, getAssetOraclePrice, conservativePriceRatio, getCollateralUsdPrice, getAssetUsdValueForEstimate, getAssetUsdValueOrZero, getTokenUsdPrice } from '~/utils/sdk-prices'
import { getAddress, formatUnits, zeroAddress, type Address } from 'viem'
import { SwapTokenSelector } from '#components'
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
import {
  getProjectedYieldState,
  mergeProjectedRewardCampaigns,
  type ProjectedYieldCampaignInput,
  type ProjectedYieldDetails,
} from '~/utils/projected-yield'
import { getLayeredVault } from '~/composables/useLayeredVaults'

// Snapshot of all borrow inputs captured at "add to batch" time. The batch
// re-simulates asynchronously (after the form may have been reset), so the plan
// must be built from these captured values rather than the live reactive refs.
export interface BorrowBatchSnapshot {
  subAccount: Address
  collateralVault: EVault
  borrowVault: EVault
  collateralAmount: string
  borrowAmount: string
  needsSwap: boolean
  selectedAsset?: VaultAsset
  isSavingCollateral: boolean
  savingCollateral?: PortfolioSavingsPosition<VaultEntity>
  isBorrowNativeWrap: boolean
  quote?: SwapQuote
}

export interface UseBorrowFormOptions {
  pair: Ref<AnyBorrowVaultPair | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  collateralVault: ComputedRef<EVault | undefined>
  formTab: Ref<'borrow' | 'multiply'>

  savingPositions: ComputedRef<PortfolioSavingsPosition<VaultEntity>[]>
  balance: Ref<bigint>

  pendingSubAccount: Ref<string | null>
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
    pendingSubAccount,
    resolvePendingSubAccount,
    collateralSupplyApyWithRewards,
    isSecuritizeCollateral,
    isGeoBlocked,
    isBorrowRestricted,
    collateralAddress,
    borrowAddress: _borrowAddress,
  } = options

  const modal = useModal()
  const { error } = useToast()
  const { planBorrow, planSwapAndBorrow, prepareTransactionPlan, prefetchPluginData, preloadSubAccountSnapshot } = useEulerTx()
  const { open: openReviewState } = useExecutionReview()
  const { create: createIntent } = useOperationIntentFactory()
  const { account: planAccount } = usePlanAccount()
  const { isConnected, isSpyMode, effectiveAddress } = useEffectiveAddress()
  const { chainId } = useEulerAddresses()
  const { getBalance } = useWallets()
  const {
    version: rewardsVersion,
    getSupplyRewardApy,
    getBorrowRewardApyForCollaterals,
    getEligibleLoopingRewardApyForCollaterals,
    getSupplyRewardCampaigns,
    getBorrowRewardCampaignsForCollaterals,
    getEligibleLoopingRewardCampaignsForCollaterals,
  } = useRewardsApy()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const { finalizeExecutionUi } = useTxFinalization()
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
    enabled: () => _formTab.value === 'borrow',
    fromSymbol: () => borrowNeedsSwap.value
      ? borrowSelectedAsset.value?.symbol
      : collateralVault.value?.asset.symbol,
    toSymbol: () => borrowNeedsSwap.value
      ? collateralVault.value?.asset.symbol
      : borrowVault.value?.asset.symbol,
  })
  const {
    sortedQuoteCards: borrowSwapQuoteCards,
    selectedProvider: borrowSwapSelectedProvider,
    selectedQuote: borrowSwapSelectedQuote,
    selectedQuoteCard: borrowSwapSelectedQuoteCard,
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
    buildTxPlanForQuote: (quote, _provider, context) => buildSwapBorrowPlanFromQuote(quote, context.account),
    createIntentsForQuote: (quote) => {
      const subAccount = pendingSubAccount.value
      if (!subAccount) throw new Error('Borrow sub-account is not resolved')
      return [createBorrowIntent({ ...captureBorrowSnapshot(getAddress(subAccount)), quote })]
    },
    getPlanAccount: () => planAccount.value,
    getStateOverrideOptions: () => buildBorrowStateOverrideOptions(),
    // First quote in each sweep resolves the plugin prefetch (Pyth Hermes /
    // keyring vault gating); subsequent quotes reuse it so per-quote prepare
    // skips Hermes pulls and keyring reads.
    prefetchPluginData: (plan, account, intents) => prefetchPluginData(plan, { account, intents }),
    prepareTransactionPlan: (plan, account, prefetch, intents) => prepareTransactionPlan(plan, { account, prefetch, intents }),
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

  let borrowSubAccountSnapshotKey: string | null = null
  let borrowSubAccountSnapshotPromise: Promise<boolean> | null = null
  const ensureBorrowSubAccountSnapshot = (account: Account<IHasVaultAddress> | undefined, subAccount: Address): Promise<boolean> => {
    if (!account) return Promise.resolve(false)
    const key = `${account.chainId}:${getAddress(subAccount)}`
    if (borrowSubAccountSnapshotKey !== key) {
      borrowSubAccountSnapshotKey = key
      borrowSubAccountSnapshotPromise = null
    }
    if (!borrowSubAccountSnapshotPromise) {
      borrowSubAccountSnapshotPromise = preloadSubAccountSnapshot(account, subAccount)
        .then(() => true)
        .catch((e) => {
          logWarn('borrow/preloadSubAccountSnapshot', e)
          return false
        })
    }
    return borrowSubAccountSnapshotPromise
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
  const projectedYieldDetails = ref<ProjectedYieldDetails | null>(null)
  const netAPY = computed<number | undefined>(() => projectedYieldDetails.value?.after.total)
  const liquidationPrice = ref<number | undefined>()

  // Swap state
  const borrowSelectedAsset = ref<VaultAsset | undefined>()
  // Pay-with balance from the central wallet entity (custom tokens fed in by
  // useCustomTokenResolver) — reactive + layer-aware.
  const borrowSelectedAssetBalance = computed(() => borrowSelectedAsset.value?.address ? getBalance(borrowSelectedAsset.value.address as Address) : 0n)
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
    if (!isConnected.value && !isSpyMode.value) return false
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

    const userAddr = (effectiveAddress.value || zeroAddress) as Address
    const subAccountAddr = effectiveAddress.value
      ? (await resolvePendingSubAccount()) as Address
      : userAddr
    await ensureBorrowSubAccountSnapshot(planAccount.value, subAccountAddr)
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
    // Selecting a Pay-with token switches execution to the wallet-funded path.
    // Do not retain a previously selected savings-share source behind that UI.
    isSavingCollateral.value = false
    selectedSavingSubAccount.value = undefined
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
      if (nextIsSaving) {
        // Set the concrete source first. The source watcher ignores this
        // preparatory change while wallet mode is still active, then reruns
        // once when savings mode becomes active.
        selectedSavingSubAccount.value = option?.subAccount
        isSavingCollateral.value = true
      }
      else {
        // Leave savings mode before clearing its disambiguator so this also
        // produces a single estimate rerun.
        isSavingCollateral.value = false
        selectedSavingSubAccount.value = undefined
      }
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
  const projectionCollateralVault = computed(() => {
    const fallback = collateralVault.value
    return fallback ? getLayeredVault(fallback.address, fallback) : undefined
  })
  const projectionBorrowVault = computed(() => {
    const fallback = borrowVault.value
    return fallback ? getLayeredVault(fallback.address, fallback) : undefined
  })
  const updateAsyncEstimates = useDebounceFn(async (gen: number) => {
    if (asyncEstimatesGuard.isStale(gen)) return
    const collateral = projectionCollateralVault.value
    const borrow = projectionBorrowVault.value
    if (!pair.value || !collateral || !borrow) {
      projectedYieldDetails.value = null
      isEstimatesLoading.value = false
      return
    }
    try {
      const account = planAccount.value
      const targetSubAccountAddress = pendingSubAccount.value
        ?? (account && effectiveAddress.value ? await resolvePendingSubAccount() : undefined)
      const targetSubAccount = account && effectiveAddress.value
        && targetSubAccountAddress
        ? account.getSubAccount(getAddress(targetSubAccountAddress))
        : undefined
      if (asyncEstimatesGuard.isStale(gen)) return

      // When swapping, use the quote output amount (collateral-vault-asset denominated)
      const collateralAmountNano = borrowNeedsSwap.value
        ? borrowSwapEffectiveQuote.value ? BigInt(borrowSwapEffectiveQuote.value.amountOut || 0) : 0n
        : valueToNano(collateralAmount.value || '0', collateral.asset.decimals)
      const collateralCashDelta = isSavingCollateral.value && !borrowNeedsSwap.value ? 0n : collateralAmountNano
      const savingsSourceAddress = normalizeAddress(savingCollateral.value?.subAccount)
      const normalizedTargetSubAccountAddress = normalizeAddress(targetSubAccountAddress)
      const isSavingsSelfTransfer = isSavingCollateral.value
        && !borrowNeedsSwap.value
        && !!savingsSourceAddress
        && savingsSourceAddress === normalizedTargetSubAccountAddress
      // The SDK omits a savings-share transfer when source and destination are
      // the same sub-account, so those assets are already present in the
      // layered position and must not be added a second time.
      const selectedCollateralAssetsDelta = isSavingsSelfTransfer ? 0n : collateralAmountNano
      const borrowAmountNano = valueToNano(borrowAmount.value || '0', borrow.asset.decimals)
      const selectedCollateralAddress = normalizeAddress(collateral.address)
      const borrowVaultAddress = normalizeAddress(borrow.address)
      if (!selectedCollateralAddress || !borrowVaultAddress) {
        projectedYieldDetails.value = null
        return
      }

      const positions = targetSubAccount?.positions ?? []
      const findPosition = (address: string) => positions.find(position =>
        normalizeAddress(position.vaultAddress) === address)
      const collateralAddresses = new Set<string>([selectedCollateralAddress])
      targetSubAccount?.enabledCollaterals.forEach((address) => {
        const normalized = normalizeAddress(address)
        if (normalized) collateralAddresses.add(normalized)
      })

      const collateralLegs: Array<{ address: string, vault: VaultEntity, assets: bigint }> = []
      for (const address of collateralAddresses) {
        const position = findPosition(address)
        const existingAssets = position?.assets ?? 0n
        const nextAssets = existingAssets + (address === selectedCollateralAddress ? selectedCollateralAssetsDelta : 0n)
        if (nextAssets <= 0n && address !== selectedCollateralAddress) continue

        const positionVault = position?.vault && 'asset' in position.vault
          ? position.vault as VaultEntity
          : undefined
        const fallbackVault = address === selectedCollateralAddress ? collateral : positionVault
        const vault = getLayeredVault(address, fallbackVault)
        if (!vault || !('asset' in vault)) {
          projectedYieldDetails.value = null
          return
        }
        collateralLegs.push({ address, vault: vault as VaultEntity, assets: nextAssets > 0n ? nextAssets : 0n })
      }

      const existingBorrowed = findPosition(borrowVaultAddress)?.borrowed ?? 0n
      const nextBorrowed = existingBorrowed + borrowAmountNano
      const projectionRequests: ProjectedRatesRequest[] = [
        {
          vaultAddress: collateral.address,
          currentCash: collateral.totalCash,
          currentBorrows: collateral.totalBorrowed,
          cashDelta: collateralCashDelta,
          borrowsDelta: 0n,
        },
        {
          vaultAddress: borrow.address,
          currentCash: borrow.totalCash,
          currentBorrows: borrow.totalBorrowed,
          cashDelta: -borrowAmountNano,
          borrowsDelta: borrowAmountNano,
        },
      ]

      const [projectedRates, collateralUsdValues, borrowUsdValue] = await Promise.all([
        getProjectedRatesBatch(projectionRequests),
        Promise.all(collateralLegs.map(leg =>
          getAssetUsdValueForEstimate(leg.assets, leg.vault, 'off-chain'))),
        getAssetUsdValueForEstimate(nextBorrowed, borrow, 'off-chain'),
      ])
      if (asyncEstimatesGuard.isStale(gen)) return
      if (
        !areProjectedRatesComplete(projectedRates, projectionRequests.length)
        || collateralUsdValues.some(value => value === undefined)
        || borrowUsdValue === undefined
      ) {
        projectedYieldDetails.value = null
        return
      }
      const projectedByAddress = new Map<string, ProjectedRates>()
      projectionRequests.forEach((request, index) => {
        const address = normalizeAddress(request.vaultAddress)
        if (!projectedByAddress.has(address)) projectedByAddress.set(address, projectedRates[index]!)
      })
      const supplyEntries = collateralLegs.map((leg, index) => {
        const supplyUsd = collateralUsdValues[index]!
        const currentRaw = getVaultSupplyApy(leg.vault)
        const projected = projectedByAddress.get(leg.address)
        const projectedRaw = projected ? nanoToValue(projected.supplyAPY, 25) : currentRaw
        const supplyApyWithIntrinsic = withProjectedVaultIntrinsicApy(
          currentRaw,
          projected ? projectedRaw : null,
          leg.vault,
          enableIntrinsicApy.value,
        )
        return {
          ...leg,
          supplyUsd,
          currentRaw,
          projectedRaw,
          intrinsicSupplyApy: supplyApyWithIntrinsic - projectedRaw,
          supplyRewardApy: getSupplyRewardApy(leg.address),
        }
      })
      const collateralUsdValue = supplyEntries.reduce((sum, entry) => sum + entry.supplyUsd, 0)
      const weightedSupply = (select: (entry: typeof supplyEntries[number]) => number) =>
        collateralUsdValue > 0
          ? supplyEntries.reduce((sum, entry) => sum + entry.supplyUsd * select(entry), 0) / collateralUsdValue
          : 0
      const projectedBaseSupplyApy = weightedSupply(entry => entry.projectedRaw)
      const projectedIntrinsicSupplyApy = weightedSupply(entry => entry.intrinsicSupplyApy)
      const projectedSupplyRewardApy = weightedSupply(entry => entry.supplyRewardApy)
      const positiveCollateralAddresses = supplyEntries
        .filter(entry => entry.assets > 0n)
        .map(entry => entry.address)

      const currentBorrowRaw = getVaultBorrowApy(borrow)
      const borrowProjected = projectedRates[1]!
      const projectedBorrowRaw = borrowProjected ? nanoToValue(borrowProjected.borrowAPY, 25) : currentBorrowRaw
      const projectedBorrowApy = withProjectedVaultIntrinsicApy(
        currentBorrowRaw,
        borrowProjected ? projectedBorrowRaw : null,
        borrow,
        enableIntrinsicApy.value,
      )
      const multiplier = getPositionMultiplier(collateralUsdValue, borrowUsdValue)
      const loopingRewardApy = getEligibleLoopingRewardApyForCollaterals(
        borrow.address,
        positiveCollateralAddresses,
        multiplier,
      )
      const after = getProjectedYieldState('net-apy', {
        supplyUsd: collateralUsdValue,
        baseSupplyApy: projectedBaseSupplyApy,
        intrinsicSupplyApy: projectedIntrinsicSupplyApy,
        supplyRewardApy: projectedSupplyRewardApy,
        borrowUsd: borrowUsdValue,
        baseBorrowApy: projectedBorrowRaw,
        intrinsicBorrowApy: projectedBorrowApy - projectedBorrowRaw,
        borrowRewardApy: getBorrowRewardApyForCollaterals(borrow.address, positiveCollateralAddresses),
        loopingRewardApy,
      })
      if (!after) {
        projectedYieldDetails.value = null
        return
      }

      const afterCampaigns: ProjectedYieldCampaignInput[] = [
        ...supplyEntries
          .filter(entry => entry.supplyUsd > 0)
          .flatMap(entry => getSupplyRewardCampaigns(entry.address)
            .map(campaign => ({ campaign, vaultAddress: entry.vault.address }))),
        ...(borrowUsdValue > 0
          ? getBorrowRewardCampaignsForCollaterals(borrow.address, positiveCollateralAddresses)
              .map(campaign => ({ campaign, vaultAddress: borrow.address }))
          : []),
        ...getEligibleLoopingRewardCampaignsForCollaterals(
          borrow.address,
          positiveCollateralAddresses,
          multiplier,
        ).map(campaign => ({ campaign, vaultAddress: borrow.address })),
      ]
      projectedYieldDetails.value = {
        metric: 'net-apy',
        after,
        rateLines: [
          ...supplyEntries.map(entry => ({
            id: `supply:${entry.address}`,
            label: 'Collateral lending APY',
            symbol: entry.vault.asset.symbol,
            vaultAddress: entry.vault.address,
            before: entry.currentRaw,
            after: entry.projectedRaw,
          })),
          {
            id: `borrow:${borrow.address.toLowerCase()}`,
            label: 'Liability borrow APY',
            symbol: borrow.asset.symbol,
            vaultAddress: borrow.address,
            before: currentBorrowRaw,
            after: projectedBorrowRaw,
          },
        ],
        rewards: mergeProjectedRewardCampaigns([], afterCampaigns),
      }
    }
    catch (e) {
      if (asyncEstimatesGuard.isStale(gen)) return
      logWarn('borrow/asyncEstimates', e)
      projectedYieldDetails.value = null
    }
    finally {
      if (!asyncEstimatesGuard.isStale(gen)) {
        isEstimatesLoading.value = false
      }
    }
  }, 500)

  const queueAsyncEstimates = () => {
    const gen = asyncEstimatesGuard.next()
    projectedYieldDetails.value = null
    const hasInput = +collateralAmount.value > 0 || +borrowAmount.value > 0
    if (!pair.value || !collateralVault.value || !borrowVault.value || !hasInput) {
      isEstimatesLoading.value = false
      return
    }
    if (borrowNeedsSwap.value && !borrowSwapEffectiveQuote.value) {
      isEstimatesLoading.value = false
      return
    }
    isEstimatesLoading.value = true
    updateAsyncEstimates(gen)
  }

  // --- Actions: submit & send ---
  const buildSwapBorrowPlanFromQuote = async (quote: SwapQuote, account = planAccount.value): Promise<TransactionPlan> => {
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
    const subAccountSnapshotApplied = await ensureBorrowSubAccountSnapshot(account, subAccount as Address)
    return planSwapAndBorrow({
      swapQuote: quote,
      amount: inputAmount,
      tokenIn: (wrappedAddress || borrowSelectedAsset.value.address) as Address,
      collateralVault: collateralVault.value.address as Address,
      borrowVault: borrowVault.value.address as Address,
      borrowAmount: borrowAmountNano,
      borrowAccount: subAccount as Address,
      account,
      subAccountSnapshotApplied,
      wrappedNativeInfo: isNative && wrappedAddress
        ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
        : undefined,
    })
  }

  // Build this form's plan for the batch ("shopping cart"), against the prior
  // layer's simulated `account`. CoW swaps can't merge into an EVC batch and are
  // gated out at the call site. `subAccountSnapshotApplied: true` keeps the layer
  // account authoritative (no on-chain re-fetch that would clobber earlier steps).
  //
  // Unlike submit/send, this runs *asynchronously* inside the batch's resimulation
  // — by then the form may have been reset or changed — so it must take a snapshot
  // of every input captured at add-time, NOT read the live reactive refs.
  const buildBorrowPlan = async (snap: BorrowBatchSnapshot, account = planAccount.value): Promise<TransactionPlan> => {
    const subAccount = snap.subAccount

    if (snap.needsSwap) {
      if (!snap.quote || !snap.selectedAsset) throw new Error('No swap quote available')
      const isNative = isNativeCurrencyAddress(snap.selectedAsset.address)
      const inputAmount = valueToNano(snap.collateralAmount || '0', snap.selectedAsset.decimals)
      const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
      if (isNative && !wrappedAddress) throw new Error('Wrapped native token not found')
      const borrowAmountNano = valueToNano(snap.borrowAmount || '0', snap.borrowVault.shares.decimals)
      return planSwapAndBorrow({
        swapQuote: snap.quote,
        amount: inputAmount,
        tokenIn: (wrappedAddress || snap.selectedAsset.address) as Address,
        collateralVault: snap.collateralVault.address as Address,
        borrowVault: snap.borrowVault.address as Address,
        borrowAmount: borrowAmountNano,
        borrowAccount: subAccount,
        account,
        subAccountSnapshotApplied: true,
        wrappedNativeInfo: isNative && wrappedAddress
          ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
          : undefined,
      })
    }

    // Standard borrow (fresh-deposit or savings-sourced collateral; collateral
    // amount may be 0 for a pure borrow against an earlier batch step's collateral).
    let collateralAmountForPlan = FixedPoint.fromValue(
      valueToNano(snap.collateralAmount || '0', snap.collateralVault.asset.decimals),
      Number(snap.collateralVault.asset.decimals),
    ).toFormat({ decimals: Number(snap.collateralVault.shares.decimals) }).value
    if (snap.isSavingCollateral) {
      if (!snap.savingCollateral) throw new Error('Savings position not found')
      collateralAmountForPlan = snap.savingCollateral.assets === collateralAmountForPlan
        ? snap.savingCollateral.shares
        : snap.collateralVault.convertToShares(collateralAmountForPlan)
    }
    const borrowAmountNano = FixedPoint.fromValue(
      valueToNano(snap.borrowAmount || '0', snap.borrowVault.asset.decimals),
      Number(snap.borrowVault.asset.decimals),
    ).toFormat({ decimals: Number(snap.borrowVault.shares.decimals) }).value
    return snap.isSavingCollateral
      ? planBorrow({
          vaultAddress: snap.borrowVault.address as Address,
          assetAddress: snap.borrowVault.asset.address as Address,
          amount: borrowAmountNano,
          borrowAccount: subAccount,
          account,
          subAccountSnapshotApplied: true,
          collateral: {
            vault: snap.collateralVault.address as Address,
            amount: collateralAmountForPlan,
            source: 'savings',
            from: snap.savingCollateral!.subAccount as Address,
          },
        })
      : planBorrow({
          vaultAddress: snap.borrowVault.address as Address,
          assetAddress: snap.borrowVault.asset.address as Address,
          amount: borrowAmountNano,
          borrowAccount: subAccount,
          account,
          subAccountSnapshotApplied: true,
          collateral: {
            vault: snap.collateralVault.address as Address,
            asset: snap.collateralVault.asset.address as Address,
            amount: collateralAmountForPlan,
            wrappedNativeInfo: snap.isBorrowNativeWrap
              ? { wrappedTokenAddress: resolveWrappedNativeAddress(chainId.value!)!, nativeAmount: collateralAmountForPlan }
              : undefined,
          },
        })
  }

  const createBorrowIntent = (snap: BorrowBatchSnapshot) => {
    const subAccount = snap.subAccount
    if (snap.needsSwap) {
      if (!snap.quote || !snap.selectedAsset) throw new Error('No swap quote available')
      const isNative = isNativeCurrencyAddress(snap.selectedAsset.address)
      const inputAmount = valueToNano(snap.collateralAmount || '0', snap.selectedAsset.decimals)
      const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
      if (isNative && !wrappedAddress) throw new Error('Wrapped native token not found')
      return createIntent({
        kind: 'borrow',
        planner: 'swap-and-borrow',
        args: {
          swapQuote: snap.quote,
          amount: inputAmount,
          tokenIn: (wrappedAddress || snap.selectedAsset.address) as Address,
          collateralVault: snap.collateralVault.address as Address,
          borrowVault: snap.borrowVault.address as Address,
          borrowAmount: valueToNano(snap.borrowAmount || '0', snap.borrowVault.shares.decimals),
          borrowAccount: subAccount,
          wrappedNativeInfo: isNative && wrappedAddress
            ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
            : undefined,
        },
        source: 'composables/borrow/useBorrowForm.ts',
        subAccounts: [subAccount],
      })
    }

    let collateralAmount = FixedPoint.fromValue(
      valueToNano(snap.collateralAmount || '0', snap.collateralVault.asset.decimals),
      Number(snap.collateralVault.asset.decimals),
    ).toFormat({ decimals: Number(snap.collateralVault.shares.decimals) }).value
    if (snap.isSavingCollateral) {
      if (!snap.savingCollateral) throw new Error('Savings position not found')
      collateralAmount = snap.savingCollateral.assets === collateralAmount
        ? snap.savingCollateral.shares
        : snap.collateralVault.convertToShares(collateralAmount)
    }
    return createIntent({
      kind: 'borrow',
      planner: 'borrow',
      args: {
        vaultAddress: snap.borrowVault.address as Address,
        assetAddress: snap.borrowVault.asset.address as Address,
        amount: FixedPoint.fromValue(
          valueToNano(snap.borrowAmount || '0', snap.borrowVault.asset.decimals),
          Number(snap.borrowVault.asset.decimals),
        ).toFormat({ decimals: Number(snap.borrowVault.shares.decimals) }).value,
        borrowAccount: subAccount,
        collateral: snap.isSavingCollateral
          ? { vault: snap.collateralVault.address as Address, amount: collateralAmount, source: 'savings', from: snap.savingCollateral!.subAccount as Address }
          : {
              vault: snap.collateralVault.address as Address,
              asset: snap.collateralVault.asset.address as Address,
              amount: collateralAmount,
              wrappedNativeInfo: snap.isBorrowNativeWrap
                ? { wrappedTokenAddress: resolveWrappedNativeAddress(chainId.value!)!, nativeAmount: collateralAmount }
                : undefined,
            },
      },
      source: 'composables/borrow/useBorrowForm.ts',
      subAccounts: [subAccount],
    })
  }

  const captureBorrowSnapshot = (subAccount: Address): BorrowBatchSnapshot => {
    if (!collateralVault.value || !borrowVault.value) throw new Error('Borrow vaults are not loaded')
    return {
      subAccount,
      collateralVault: collateralVault.value,
      borrowVault: borrowVault.value,
      collateralAmount: collateralAmount.value,
      borrowAmount: borrowAmount.value,
      needsSwap: borrowNeedsSwap.value,
      selectedAsset: borrowSelectedAsset.value,
      isSavingCollateral: isSavingCollateral.value,
      savingCollateral: savingCollateral.value,
      isBorrowNativeWrap: isBorrowNativeWrap.value,
      quote: borrowNeedsSwap.value ? borrowSwapEffectiveQuote.value ?? undefined : undefined,
    }
  }

  const submit = async () => {
    if (isOperationBlocked.value) return
    if (isPreparing.value || isGeoBlocked.value || isBorrowRestricted.value || isBorrowSwapRestricted.value || isBorrowPayWithBlocked.value) return
    isPreparing.value = true
    try {
      if (!isConnected.value && !isSpyMode.value) {
        isSubmitting.value = false
        return
      }

      if (!borrowVault.value || !collateralVault.value) {
        return
      }

      // Swap & borrow path
      if (borrowNeedsSwap.value && borrowSwapEffectiveQuote.value) {
        const subAccount = (await resolvePendingSubAccount()) as Address
        const snapshot = captureBorrowSnapshot(subAccount)
        const quoteIntents = borrowSwapSelectedQuoteCard.value?.quote === snapshot.quote
          ? borrowSwapSelectedQuoteCard.value.intents
          : undefined
        const intents = quoteIntents?.length ? quoteIntents : [createBorrowIntent(snapshot)]
        try {
          const account = planAccount.value
          await ensureBorrowSubAccountSnapshot(account, subAccount)
          plan.value = await buildBorrowPlan(snapshot, account)
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
        if (!plan.value) return
        await openReviewState(intents, {
          presentationKind: 'swap-borrow',
          review: {
            type: 'swap-borrow' as const,
            asset: reviewAsset,
            amount: collateralAmount.value,
            quoteFetchedAt: borrowSwapEffectiveQuoteFetchedAt.value,
            swapToAsset: collateralVault.value.asset,
            swapToAmount: borrowSwapEstimatedCollateral.value,
            swapMode: SwapperMode.EXACT_IN,
            submittingLabel: 'Submitting...',
          },
          onSucceeded: () => finalizeExecutionUi(),
          onFailed: (cause) => {
            logWarn('borrow/send', cause)
            error('Transaction failed')
          },
        })
        return
      }

      // Standard borrow path
      const subAccountAddr = (await resolvePendingSubAccount()) as Address
      const snapshot = captureBorrowSnapshot(subAccountAddr)
      const intent = createBorrowIntent(snapshot)
      try {
        const account = planAccount.value
        await ensureBorrowSubAccountSnapshot(account, subAccountAddr)
        plan.value = await buildBorrowPlan(snapshot, account)
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

      if (!plan.value) return
      await openReviewState([intent], {
        presentationKind: 'borrow',
        review: {
          type: 'borrow',
          asset: borrowVault.value?.asset,
          amount: borrowAmount.value,
          supplyingAssetForBorrow: collateralVault.value?.asset,
          supplyingAmount: collateralAmount.value,
          submittingLabel: 'Submitting...',
        },
        onSucceeded: () => finalizeExecutionUi(),
        onFailed: (cause) => {
          logWarn('borrow/send', cause)
          error('Transaction failed')
        },
      })
    }
    finally {
      isPreparing.value = false
    }
  }

  // --- Actions: balance ---
  // No-op kept for callers; borrowSelectedAssetBalance is now a reactive computed.
  const updateBorrowSwapAssetBalance = async () => {}

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
  watch(ltv, () => {
    updateSyncEstimates()
  })

  watch([collateralAmount, borrowAmount], () => {
    clearBorrowSimulationError()
    if (!pair.value) {
      asyncEstimatesGuard.next()
      projectedYieldDetails.value = null
      isEstimatesLoading.value = false
      return
    }
    updateSyncEstimates()
    queueAsyncEstimates()
  })

  watch([
    pair,
    collateralVault,
    borrowVault,
    planAccount,
    effectiveAddress,
    pendingSubAccount,
    () => projectionCollateralVault.value?.totalCash,
    () => projectionCollateralVault.value?.totalBorrowed,
    () => projectionBorrowVault.value?.totalCash,
    () => projectionBorrowVault.value?.totalBorrowed,
  ], () => {
    asyncEstimatesGuard.next()
    projectedYieldDetails.value = null
    const hasInput = +collateralAmount.value > 0 || +borrowAmount.value > 0
    if (!pair.value || !collateralVault.value || !borrowVault.value || !hasInput) {
      isEstimatesLoading.value = false
      return
    }
    updateSyncEstimates()
    queueAsyncEstimates()
  }, { flush: 'sync' })

  watch([isSavingCollateral, selectedSavingSubAccount], ([isSaving, selected], [wasSaving, previousSelected]) => {
    const sourceChanged = isSaving !== wasSaving
      || (isSaving && selected !== previousSelected)
    if (!sourceChanged) return
    // Source changes do not change either amount, but they do change whether
    // collateral enters the vault as new cash and whether it is a self-transfer.
    // Invalidate synchronously so an older request cannot publish between the
    // source change and this rerun.
    clearBorrowSimulationError()
    queueAsyncEstimates()
  }, { flush: 'sync' })

  watch([rewardsVersion, enableIntrinsicApy], () => {
    queueAsyncEstimates()
  })

  watch(borrowSelectedAsset, async () => {
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
      queueAsyncEstimates()
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
    projectedYieldDetails,
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
    isBorrowNativeWrap,

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
    borrowSwapEffectiveQuoteFetchedAt,
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
    buildBorrowPlan, // Batch
    createBorrowIntent,
    updateEstimates: () => {
      updateSyncEstimates()
      queueAsyncEstimates()
    },
    updateBorrowSwapAssetBalance,
    resetOnTabSwitch,
  }
}
