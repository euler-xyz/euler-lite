import type { SecuritizeCollateralVault, EVault, TransactionPlan, TransactionPlanPrepared, SwapQuote, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { getAddress, formatUnits, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { OperationReviewModal, SlippageSettingsModal } from '#components'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { getAssetUsdValue } from '~/utils/sdk-prices'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry, getVaultTags } from '~/composables/useGeoBlock'
import { useSwapQuotesParallel, type SwapQuoteIncludeCowSwap, type SwapQuotePlanAccount, type SwapQuotePlanContext } from '~/composables/useSwapQuotesParallel'
import { useStateOverrideOptions } from '~/composables/useStateOverrideOptions'
import { getQuoteAmount, type SwapQuoteAmountField, type SwapQuoteCompare } from '~/utils/swapQuotes'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import type { SwapQuoteInput } from '~/composables/useSwapApi'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { isSameUnderlyingAsset, isSameVault as isSameVaultCheck } from '~/utils/vault-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'

export interface UseSwapPageLogicOptions {
  /** Which quote field the swap engine optimises for ('amountIn' = min cost, 'amountOut' = max output) */
  amountField: SwapQuoteAmountField
  /** Quote ranking direction */
  compare: SwapQuoteCompare
  /** Source vault — may be SecuritizeCollateralVault (collateral/lend) */
  fromVault: Ref<EVault | SecuritizeCollateralVault | undefined>
  /** Target vault — composable writes to this ref via syncToVault / onToVaultChange */
  toVault: Ref<EVault | undefined>
  /** Source balance (e.g. currentDebt or deposit assets) */
  balance: ComputedRef<bigint>
  /** Vault list shown in the "To" dropdown */
  vaultOptions: ComputedRef<EVault[]>
  /** Which quote field to display as the "To" amount and in route cards */
  displayAmountField: SwapQuoteAmountField
  /** Prefix for non-best quote diff badges ('+' for min compare, '-' for max compare) */
  quoteDiffPrefix: string

  /**
   * Build the swap-API params for a given input amount.
   * Return `null` to skip the request (e.g. amount exceeds debt).
   */
  buildQuoteRequest: (amount: bigint) => { params: SwapQuoteInput } | null
  /** Build the TransactionPlan for the current swap (same-asset or quote-based). Must throw on failure. */
  buildPlan: (quote?: SwapQuote, context?: SwapQuotePlanContext) => Promise<TransactionPlan>
  /** Page-specific balance validation error. Receives the parsed nano amount. */
  getBalanceError: (amountNano: bigint) => string | null
  /** Vault addresses to check for geo-blocking */
  getGeoBlockedAddresses: () => string[]
  /** Where to redirect after a successful transaction */
  redirectPath: string

  /** Optional route.query.to value — used in syncToVault to pick target vault from URL */
  targetVaultAddress?: Ref<string>
  /** Extra error computeds that block submission (e.g. healthError for borrow) */
  additionalErrors?: ComputedRef<string | null>[]
  /** Custom USD-value computation for price impact (collateral page uses oracle perspective) */
  computePriceImpact?: (quote: SwapQuote) => Promise<number | null>
  /** Modal type when from/to share the same underlying asset. Default 'transfer'; borrow uses 'swap'. */
  sameAssetModalType?: 'transfer' | 'swap'
  /** Mode the page quotes its swap in. Drives the review-modal "Swap to repay" relabel
   *  and which leg is rendered as estimated. */
  swapperMode: SwapperMode
  /** Override the displayed side marked as estimated in the review modal. */
  reviewSwapEstimatedSide?: 'input' | 'output'
  /** Include CowSwap provider in swap quotes (Ethereum mainnet etc.) */
  includeCowSwap?: SwapQuoteIncludeCowSwap
  /** Optional already-loaded Account for SDK plan/plugin processing. */
  getPlanAccount?: () => SwapQuotePlanAccount | undefined
}

export const useSwapPageLogic = (options: UseSwapPageLogicOptions) => {
  const {
    amountField,
    compare,
    fromVault,
    toVault,
    balance: _balance,
    vaultOptions,
    displayAmountField,
    quoteDiffPrefix,
    buildQuoteRequest,
    buildPlan,
    getBalanceError,
    getGeoBlockedAddresses,
    redirectPath,
    targetVaultAddress,
    additionalErrors = [],
    computePriceImpact,
    sameAssetModalType = 'transfer',
    swapperMode,
    reviewSwapEstimatedSide,
    includeCowSwap,
    getPlanAccount,
  } = options

  const otherAmountField: SwapQuoteAmountField = displayAmountField === 'amountIn' ? 'amountOut' : 'amountIn'

  const router = useRouter()
  const route = useRoute()
  const { isConnected } = useWagmi()
  const { isSpyMode } = useSpyMode()
  const { executePlan, executePreparedPlan, prepareTransactionPlan, prefetchPluginData } = useEulerTx()
  const modal = useModal()
  const { error: showError } = useToast()
  const { runSimulation, runPreparedSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
  const { account: defaultPlanAccount } = usePlanAccount()
  // Debt-swap / collateral-swap pages don't consume the user's wallet ERC20
  // balance — the source is an existing position. Safe to skip balance
  // overrides (no balanceOf RPC + no balance-slot probing per estimate).
  const { primeSlotHintsFor, buildStateOverrideOptions } = useStateOverrideOptions()
  const buildSwapStateOverrideOptions = () => buildStateOverrideOptions({ noBalanceOverride: true })

  // ── State ──────────────────────────────────────────────────────────────
  const isLoading = ref(false)
  const isSubmitting = ref(false)
  const isPreparing = ref(false)
  const plan = ref<TransactionPlan | null>(null)
  const preparedPlan = shallowRef<TransactionPlanPrepared | null>(null)
  const fromAmount = ref('')
  const toAmount = ref('')
  const { slippage } = useSlippage({
    fromSymbol: () => fromVault.value?.asset.symbol,
    toSymbol: () => toVault.value?.asset.symbol,
  })

  // ── Quote engine ───────────────────────────────────────────────────────
  const {
    sortedQuoteCards: quoteCardsSorted,
    selectedProvider,
    selectedQuote,
    selectedQuoteCard,
    effectiveQuote,
    effectiveQuoteFetchedAt,
    providersCount,
    isLoading: isQuoteLoading,
    quoteError,
    statusLabel: quotesStatusLabel,
    getQuoteDiffPct,
    reset: resetQuoteStateInternal,
    requestQuotes,
    selectProvider,
  } = useSwapQuotesParallel({
    amountField,
    compare,
    includeCowSwap,
    // Each call site already encodes the same-asset vs swap-quote branch in
    // its own buildPlan. We just forward the candidate quote so the parallel
    // engine can build a plan per quote for gas estimation.
    buildTxPlanForQuote: (quote, _provider, context) => buildPlan(quote, context),
    getPlanAccount: () => getPlanAccount?.() ?? defaultPlanAccount.value,
    getStateOverrideOptions: () => buildSwapStateOverrideOptions(),
    // Sweep-scoped prefetch — Pyth Hermes / keyring vault gating resolved once
    // per fetch instead of per-quote.
    prefetchPluginData: (plan, account) => prefetchPluginData(plan, { account }),
    prepareTransactionPlan: (plan, account, prefetch) => prepareTransactionPlan(plan, { account, prefetch }),
  })
  // ── Vault products & price invert ──────────────────────────────────────
  const fromProduct = useEulerProductOfVault(computed(() => fromVault.value?.address || ''))
  const toProduct = useEulerProductOfVault(computed(() => toVault.value?.address || ''))
  const swapPriceInvert = usePriceInvert(
    () => fromVault.value?.asset.symbol,
    () => toVault.value?.asset.symbol,
  )

  // ── Helpers ────────────────────────────────────────────────────────────
  const normalizeAddress = (addr?: string): string => {
    if (!addr) return ''
    try {
      return getAddress(addr)
    }
    catch { return '' }
  }

  // ── Quote → toAmount sync ─────────────────────────────────────────────
  const quote = computed(() => effectiveQuote.value || null)

  watch([quote, toVault], () => {
    if (!quote.value || !toVault.value) {
      if (!isSameUnderlyingAsset(fromVault.value, toVault.value)) {
        toAmount.value = ''
      }
      return
    }
    const amount = getQuoteAmount(quote.value, displayAmountField)
    if (amount <= 0n) {
      toAmount.value = ''
      return
    }
    const formatted = formatUnits(amount, Number(toVault.value.shares.decimals))
    toAmount.value = formatSmartAmount(formatted).replace(/,/g, '')
  }, { immediate: true })

  // ── Quote state helpers ────────────────────────────────────────────────
  const resetQuoteState = () => {
    resetQuoteStateInternal()
    toAmount.value = ''
  }

  const onRefreshQuotes = () => {
    resetQuoteState()
    isQuoteLoading.value = true
    requestQuote()
  }

  // ── syncToVault ────────────────────────────────────────────────────────
  const syncToVault = () => {
    if (!fromVault.value) return
    const opts = vaultOptions.value.filter(v => !isSameVaultCheck(fromVault.value, v))
    if (!opts.length) {
      toVault.value = undefined
      return
    }

    const targetAddr = targetVaultAddress ? normalizeAddress(unref(targetVaultAddress)) : ''
    const currentAddr = toVault.value ? normalizeAddress(toVault.value.address) : ''
    const nextVault
      = (targetAddr && opts.find(v => normalizeAddress(v.address) === targetAddr))
        || opts.find(v => normalizeAddress(v.address) === currentAddr)
        || opts.find(v => !getVaultTags(v.address, 'swap-target').disabled)
        || opts[0]

    if (nextVault && (!toVault.value || normalizeAddress(toVault.value.address) !== normalizeAddress(nextVault.address))) {
      toVault.value = nextVault
    }
  }

  const syncWatchSources = targetVaultAddress
    ? [vaultOptions, fromVault, targetVaultAddress] as const
    : [vaultOptions, fromVault] as const
  watch(syncWatchSources, () => syncToVault(), { immediate: true })

  // Pre-prime ERC20 slot hints for the assets on either side of the swap. One
  // probe per token, owner-/spender-agnostic; the SDK reuses the result on
  // every estimate/sim/prepare from this page.
  watch(
    [fromVault, toVault],
    ([from, to]) => {
      const tokens: Address[] = []
      const seen = new Set<string>()
      const push = (addr?: string) => {
        if (!addr) return
        const key = addr.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        tokens.push(addr as Address)
      }
      push(from?.asset?.address)
      push(to?.asset?.address)
      if (tokens.length) void primeSlotHintsFor(tokens)
    },
    { immediate: true },
  )

  // ── Same vault / same asset ────────────────────────────────────────────
  const isSameVault = computed(() => isSameVaultCheck(fromVault.value, toVault.value))
  const isSameAsset = computed(() => {
    if (isSameVault.value) return false
    return isSameUnderlyingAsset(fromVault.value, toVault.value)
  })
  const sameVaultError = computed(() => isSameVault.value ? 'Select a different vault' : null)

  // ── Quote request (debounced) ──────────────────────────────────────────
  const requestQuote = useDebounceFn(async () => {
    quoteError.value = null

    if (!fromVault.value || !toVault.value || !fromAmount.value || isSameVault.value) {
      resetQuoteState()
      return
    }
    if (isSameAsset.value) {
      resetQuoteStateInternal()
      return
    }

    let amount: bigint
    try {
      amount = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
    }
    catch {
      resetQuoteState()
      return
    }
    if (!amount || amount <= 0n) {
      resetQuoteState()
      return
    }

    const request = buildQuoteRequest(amount)
    if (!request) {
      resetQuoteState()
      return
    }

    toAmount.value = ''
    await requestQuotes(request.params)
  }, 500)

  // ── Input handlers ─────────────────────────────────────────────────────
  const onFromInput = () => {
    clearSimulationError()
    if (!fromVault.value || !toVault.value || !fromAmount.value || isSameVault.value) {
      toAmount.value = ''
      resetQuoteState()
      return
    }
    if (isSameAsset.value) {
      resetQuoteState()
      toAmount.value = fromAmount.value
      return
    }
    toAmount.value = ''
    requestQuote()
  }

  const onToVaultChange = (selectedIndex: number) => {
    clearSimulationError()
    const nextVault = vaultOptions.value[selectedIndex]
    if (!nextVault) return
    if (isSameVaultCheck(fromVault.value, nextVault)) {
      toVault.value = undefined
      return
    }
    if (!toVault.value || normalizeAddress(toVault.value.address) !== normalizeAddress(nextVault.address)) {
      toVault.value = nextVault
    }
  }

  // ── Watchers ───────────────────────────────────────────────────────────
  watch(toVault, () => {
    clearSimulationError()
    if (!toVault.value || isSameVault.value) {
      toAmount.value = ''
      resetQuoteState()
      return
    }
    if (isSameAsset.value) {
      resetQuoteState()
      toAmount.value = fromAmount.value
      return
    }
    if (fromAmount.value) {
      onFromInput()
    }
  })

  watch([toVault, fromVault], ([targetVault, sourceVault]) => {
    if (!targetVault || !sourceVault) return
    if (isSameVaultCheck(sourceVault, targetVault)) {
      toVault.value = undefined
    }
  }, { immediate: true })

  watch([fromVault, slippage], () => {
    clearSimulationError()
    if (fromAmount.value) {
      requestQuote()
    }
  })

  watch(selectedQuote, () => {
    clearSimulationError()
  })

  watch([isSameAsset, fromAmount], ([same, from]) => {
    if (same && from) {
      toAmount.value = from as string
    }
  })

  // ── Validation ─────────────────────────────────────────────────────────
  const errorText = computed(() => {
    if (!fromVault.value?.asset || !fromAmount.value) return null
    let amountNano: bigint
    try {
      amountNano = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
    }
    catch {
      return null
    }
    const balanceErr = getBalanceError(amountNano)
    if (balanceErr) return balanceErr
    if (selectedQuote.value && amountNano > 0n) {
      const amountOut = getQuoteAmount(selectedQuote.value, 'amountOut')
      if (amountOut <= 0n) return 'Output amount is below minimum'
    }
    return null
  })

  const isSubmitDisabled = computed(() => {
    if (!isConnected.value && !isSpyMode.value) return false
    if (!fromVault.value?.asset || !toVault.value?.asset) return true
    if (isSameAsset.value) {
      return isLoading.value || !(+fromAmount.value) || !!errorText.value || isSameVault.value
    }
    if (!selectedQuote.value) return true
    const amountOut = getQuoteAmount(selectedQuote.value, 'amountOut')
    if (isLoading.value || isQuoteLoading.value || !(+fromAmount.value) || !toAmount.value || isSameVault.value || amountOut <= 0n || !!errorText.value) {
      return true
    }
    return additionalErrors.some(err => !!err.value)
  })

  const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(...getGeoBlockedAddresses()))

  const reviewSwapLabel = computed(() => {
    if (isSameAsset.value) return 'Review Transfer'
    return selectedQuote.value ? 'Review Swap' : 'Select a Quote'
  })

  const reviewSwapDisabled = computed(() => isGeoBlocked.value || isSubmitDisabled.value)

  // ── Display ────────────────────────────────────────────────────────────
  const currentPrice = computed(() => {
    if (!quote.value || !fromVault.value || !toVault.value) return null
    // otherAmountField → "from" side → fromVault.asset.decimals
    // displayAmountField → "to" side → toVault.asset.decimals
    const fromSide = Number(formatUnits(BigInt(quote.value[otherAmountField]), Number(fromVault.value.asset.decimals)))
    const toSide = Number(formatUnits(BigInt(quote.value[displayAmountField]), Number(toVault.value.asset.decimals)))
    if (!fromSide || !toSide) return null
    return {
      value: fromSide / toSide,
      symbol: `${fromVault.value.asset.symbol}/${toVault.value.asset.symbol}`,
    }
  })

  const swapSummary = computed(() => {
    if (!quote.value || !fromVault.value || !toVault.value) return null
    const fromSide = formatUnits(BigInt(quote.value[otherAmountField]), Number(fromVault.value.asset.decimals))
    const toSide = formatUnits(BigInt(quote.value[displayAmountField]), Number(toVault.value.asset.decimals))
    return {
      from: `${formatSmartAmount(fromSide)} ${fromVault.value.asset.symbol}`,
      to: `${formatSmartAmount(toSide)} ${toVault.value.asset.symbol}`,
      fromExact: `${fromSide} ${fromVault.value.asset.symbol}`,
      toExact: `${toSide} ${toVault.value.asset.symbol}`,
    }
  })

  // ── Price impact ───────────────────────────────────────────────────────
  const priceImpact = ref<number | null>(null)
  const shouldGateUnknownPriceImpact = computed(() =>
    !isSameAsset.value && quote.value !== null && priceImpact.value === null,
  )
  const { guardWithPriceImpact } = usePriceImpactGate({
    directPriceImpact: priceImpact,
    shouldGateUnknown: shouldGateUnknownPriceImpact,
  })

  watchEffect(async () => {
    if (!quote.value || !fromVault.value || !toVault.value) {
      priceImpact.value = null
      return
    }
    if (computePriceImpact) {
      priceImpact.value = await computePriceImpact(quote.value)
      return
    }
    // Default: USD-value both sides using getAssetUsdValue
    // otherAmountField = "from" side → fromVault, displayAmountField = "to" side → toVault
    const fromUsd = await getAssetUsdValue(BigInt(quote.value[otherAmountField]), fromVault.value, 'off-chain')
    const toUsd = await getAssetUsdValue(BigInt(quote.value[displayAmountField]), toVault.value, 'off-chain')
    if (!fromUsd || !toUsd) {
      priceImpact.value = null
      return
    }
    const impact = (toUsd / fromUsd - 1) * 100
    priceImpact.value = Number.isFinite(impact) ? impact : null
  })

  // ── Routed via ─────────────────────────────────────────────────────────
  const routedVia = computed(() => {
    if (!selectedProvider.value) return isSameAsset.value ? null : 'Not selected'
    if (!quote.value?.route?.length) return null
    return quote.value.route.map(r => r.providerName).join(', ')
  })

  // ── Swap route cards ───────────────────────────────────────────────────
  const swapRouteItems = computed(() => {
    if (!toVault.value) return []
    return buildSwapRouteItems({
      quoteCards: quoteCardsSorted.value,
      getQuoteDiffPct,
      decimals: Number(toVault.value.shares.decimals),
      symbol: toVault.value.asset.symbol,
      formatAmount: formatSmartAmount,
      amountField: displayAmountField,
      compare,
      diffPrefix: quoteDiffPrefix,
    })
  })

  const swapRouteEmptyMessage = computed(() => {
    return providersCount.value ? 'No quotes found' : 'Enter amount to fetch quotes'
  })

  // ── Slippage settings ──────────────────────────────────────────────────
  const openSlippageSettings = () => {
    modal.open(SlippageSettingsModal)
  }

  const getSelectedPreparedQuotePlan = () => {
    if (isSameAsset.value || !selectedQuote.value) return null
    const card = selectedQuoteCard.value
    if (!card?.preparedPlan || card.quote !== selectedQuote.value) return null
    return {
      plan: card.plan ?? card.preparedPlan.plan,
      prepared: card.preparedPlan as TransactionPlanPrepared,
    }
  }

  const currentPlanAccount = () => getPlanAccount?.() ?? defaultPlanAccount.value
  const currentPlanContext = (): SwapQuotePlanContext => {
    const account = currentPlanAccount()
    return typeof account === 'string' ? {} : { account }
  }

  // ── Submit flow ────────────────────────────────────────────────────────
  const submit = async () => {
    if (isOperationBlocked.value) return
    if (isPreparing.value || isGeoBlocked.value) return
    isPreparing.value = true
    try {
      await guardWithPriceImpact(async () => {
        if (isSubmitting.value || !fromVault.value) return
        if (!isSameAsset.value && !selectedQuote.value) return

        preparedPlan.value = null
        plan.value = null
        try {
          const preparedQuotePlan = getSelectedPreparedQuotePlan()
          if (preparedQuotePlan) {
            plan.value = preparedQuotePlan.plan
            preparedPlan.value = preparedQuotePlan.prepared
          }
          else {
            plan.value = await buildPlan(undefined, currentPlanContext())
            preparedPlan.value = await prepareTransactionPlan(plan.value, { account: currentPlanAccount() })
          }
        }
        catch (e) {
          logWarn('swap/buildPlan', e)
          showError('Failed to build transaction')
          plan.value = null
          preparedPlan.value = null
          return
        }

        if (preparedPlan.value) {
          const ok = await runPreparedSimulation(preparedPlan.value, buildSwapStateOverrideOptions())
          if (!ok) return
        }
        else if (plan.value) {
          const ok = await runSimulation(plan.value, buildSwapStateOverrideOptions())
          if (!ok) return
        }

        const showSwapAmounts = sameAssetModalType === 'transfer' || !isSameAsset.value
        modal.open(OperationReviewModal, {
          props: {
            type: isSameAsset.value ? sameAssetModalType : 'swap',
            asset: fromVault.value.asset,
            amount: fromAmount.value,
            swapToAsset: showSwapAmounts ? toVault.value?.asset : undefined,
            swapToAmount: showSwapAmounts ? toAmount.value : undefined,
            swapMode: showSwapAmounts ? swapperMode : undefined,
            swapEstimatedSide: showSwapAmounts ? reviewSwapEstimatedSide : undefined,
            plan: preparedPlan.value ? undefined : (plan.value || undefined),
            prepared: preparedPlan.value || undefined,
            quoteFetchedAt: !isSameAsset.value ? effectiveQuoteFetchedAt.value : null,
            onConfirm: async () => {
              await send()
            },
            submittingLabel: 'Submitting...',
          },
        })
      })
    }
    finally {
      isPreparing.value = false
    }
  }

  const send = async () => {
    if (!fromVault.value || !toVault.value) return
    if (!isSameAsset.value && !selectedQuote.value) return

    isSubmitting.value = true
    try {
      if (preparedPlan.value) {
        await executePreparedPlan(preparedPlan.value)
      }
      else {
        const txPlan = await buildPlan(undefined, currentPlanContext())
        await executePlan(txPlan)
      }
      modal.close()
      setTimeout(() => {
        router.replace({ path: redirectPath, query: { network: route.query.network } })
      }, 400)
    }
    catch (e) {
      showError('Transaction failed')
      logWarn('swap/send', e)
    }
    finally {
      isSubmitting.value = false
    }
  }

  return {
    // State
    isLoading,
    isSubmitting,
    isPreparing,
    plan,
    fromAmount,
    toAmount,
    slippage,

    // Quote state
    quote,
    quoteCardsSorted,
    selectedProvider,
    selectedQuote,
    effectiveQuoteFetchedAt,
    providersCount,
    isQuoteLoading,
    quoteError,
    quotesStatusLabel,
    selectProvider,

    // Vault identity
    isSameVault,
    isSameAsset,
    sameVaultError,

    // Validation
    errorText,
    isSubmitDisabled,
    isGeoBlocked,
    reviewSwapDisabled,
    reviewSwapLabel,
    simulationError,
    clearSimulationError,

    // Display
    fromProduct,
    toProduct,
    swapPriceInvert,
    currentPrice,
    swapSummary,
    priceImpact,
    routedVia,
    swapRouteItems,
    swapRouteEmptyMessage,

    // Actions
    onFromInput,
    onToVaultChange,
    onRefreshQuotes,
    submit,
    openSlippageSettings,

    // Utilities
    normalizeAddress,
    requestQuote,
    resetQuoteState,
  }
}
