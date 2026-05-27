import { getProjectedRates, getNetAPY } from '~/utils/vault/apy'
import type { EVault, SecuritizeCollateralVault, TransactionPlan, TransactionPlanPrepared, SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { isEVault, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import type { VaultAsset } from '~/types/asset'
import { getAssetUsdValueOrZero, getCollateralUsdValueOrZero } from '~/utils/sdk-prices'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry, isAssetBlockedByCountry, isAssetRestrictedByCountry } from '~/composables/useGeoBlock'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { useStateOverrideOptions } from '~/composables/useStateOverrideOptions'
import { useFreshAccount } from '~/composables/useFreshAccount'
import type { SwapTokenSelectMeta } from '~/components/entities/asset/SwapTokenSelector.vue'
import type { SwapQuoteInput } from '~/composables/useSwapApi'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { formatSmartAmount } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { isOpDisabled, OP_DEPOSIT, OP_WITHDRAW } from '~/utils/vault-hooks'
import { getHookDisabledWarning } from '~/composables/useVaultWarnings'
import { decimalLtvToBps, getBorrowPositionEffectiveLiquidationLTV } from '~/utils/ltv'
import { type Address, type Abi, formatUnits, zeroAddress } from 'viem'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import { SwapTokenSelector, SlippageSettingsModal, OperationReviewModal } from '#components'
import type { ComputedRef } from 'vue'
import { logWarn } from '~/utils/errorHandling'
import { createRaceGuard } from '~/utils/race-guard'
import { FixedPoint } from '~/utils/fixed-point'
import { getTotalCollateralValue } from '~/utils/position-estimates'
import { getTxErrorMessage } from '~/utils/tx-errors'

export interface UseCollateralFormOptions {
  mode: 'supply' | 'withdraw'

  needsSwap: ComputedRef<boolean>
  effectiveBalance: ComputedRef<bigint>
  // Asset whose decimals match `effectiveBalance`. In swap mode this is the
  // "pay with" token (differs from collateralVault.asset). Used to convert
  // the user-entered amount into the same unit as effectiveBalance for the
  // balance check — without this the comparison silently mixes decimals.
  effectiveAsset: ComputedRef<VaultAsset | undefined>

  computePriceFixed: (
    position: NonNullable<ReturnType<ReturnType<typeof useEulerAccount>['getPositionBySubAccountIndex']>>,
    borrowVault?: EVault,
    collateralVault?: EVault | SecuritizeCollateralVault,
  ) => FixedPoint

  computeLiquidationPrice: (
    position: NonNullable<ReturnType<ReturnType<typeof useEulerAccount>['getPositionBySubAccountIndex']>>,
    borrowVault?: EVault | undefined,
    collateralVault?: EVault | SecuritizeCollateralVault,
  ) => number | undefined

  validateEstimate: (ctx: {
    amountFixed: FixedPoint
    suppliedFixed: FixedPoint
    borrowedFixed: FixedPoint
    priceFixed: FixedPoint
    collateralValue: FixedPoint
    userLtvFixed: FixedPoint
    needsSwap: boolean
  }) => void

  buildDirectPlan: (ctx: {
    vaultAddress: string
    assetAddress: string
    amountNano: bigint
    subAccount?: string
  }) => Promise<TransactionPlan>

  buildSwapPlan: (quote: SwapQuote, ctx: {
    vaultAddress: string
    amountNano: bigint
    slippage: number
    subAccount?: string
  }) => Promise<TransactionPlan>

  requestSwapQuoteParams: (ctx: {
    userAddr: Address
    subAccountAddr: Address
    amountNano: bigint
    slippage: number
    asset: VaultAsset
    vaultAddress: string
  }) => SwapQuoteInput | null

  getSwapOutputAsset: () => VaultAsset | undefined

  reviewLabel: string
  reviewType: string
  swapReviewType: string
  getReviewAsset: (needsSwap: boolean) => VaultAsset | undefined
  getSwapToAsset: () => VaultAsset | undefined

  onAfterLoad?: () => Promise<void> | void
  onAfterSend?: () => Promise<void> | void

  /**
   * When true, route plan construction through the prepared-envelope pipeline:
   * builds the raw plan, runs {@link prepareTransactionPlan} once, simulates
   * against the envelope, opens the modal with `prepared`, and uses
   * `executePreparedPlan` on confirm. Plugin reads (TOS / Keyring / Pyth) run
   * exactly once per Review click — no in-modal preparation spinner.
   *
   * Callers should also pass their cached account into their `buildDirectPlan`/
   * `buildSwapPlan` closures (via the SDK planner's optional `account` arg) so
   * the per-click `freshPlanContext.fetchAccount` round-trip is skipped.
   */
  usePreparedPipeline?: boolean
}

export const useCollateralForm = (options: UseCollateralFormOptions) => {
  const route = useRoute()
  const modal = useModal()
  const { error } = useToast()
  const submitLabel = options.reviewLabel
  const { executePlan, executePreparedPlan, prepareTransactionPlan, prefetchPluginData } = useEulerTx()
  const { account: freshAccount } = useFreshAccount()
  // `effectiveBalance` is form-validated in `isSubmitDisabled`. In supply mode that
  // is the wallet ERC20 balance, so `noBalanceOverride: true` saves a balanceOf
  // RPC per estimate/sim. In withdraw mode the operation doesn't need wallet
  // ERC20 balance, but slot hints + wallet snapshot still help allowance
  // overrides.
  const { primeSlotHintsFor, buildStateOverrideOptions } = useStateOverrideOptions()
  const buildCollateralStateOverrideOptions = () =>
    buildStateOverrideOptions({ noBalanceOverride: options.mode === 'supply' })
  const { isConnected, address } = useWagmi()
  const { isSpyMode } = useSpyMode()
  const { finalizeTxAndRedirect } = useTxFinalization()
  const positionIndex = usePositionIndex()
  const { isPositionsLoaded, getPositionBySubAccountIndex } = useEulerAccount()
  const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const { runSimulation, runPreparedSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
  const { isReady: isVaultsReady } = useVaults()
  const { getOrFetch } = useVaultRegistry()
  const { eulerLensAddresses, isReady: isEulerAddressesReady, loadEulerConfig } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()

  // --- Shared reactive state ---
  const isLoading = ref(false)
  const isSubmitting = ref(false)
  const isPreparing = ref(false)
  const isEstimatesLoading = ref(false)
  const amount = ref('')
  const plan = ref<TransactionPlan | null>(null)
  // `shallowRef` so Vue doesn't deep-unwrap the envelope's Account class
  // entity — the class has private brand members that drop on UnwrapRef.
  const preparedPlan = shallowRef<TransactionPlanPrepared | null>(null)
  const estimateNetAPY = ref(0)
  const estimateUserLTV = ref(0n)
  const estimateHealth = ref(0n)
  const estimatesError = ref('')
  const selectedCollateral = ref<EVault | SecuritizeCollateralVault | null>(null)
  const selectedCollateralAssets = ref(0n)
  const lastCollateralAddress = ref('')

  // --- Swap infrastructure ---
  const { slippage: swapSlippage } = useSlippage({
    fromSymbol: () => collateralVault.value?.asset.symbol,
    toSymbol: () => borrowVault.value?.asset.symbol,
  })
  const {
    sortedQuoteCards: swapQuoteCardsSorted,
    selectedProvider: swapSelectedProvider,
    selectedQuote: swapSelectedQuote,
    effectiveQuote: swapEffectiveQuote,
    providersCount: swapProvidersCount,
    isLoading: isSwapQuoteLoading,
    quoteError: swapQuoteError,
    statusLabel: swapQuotesStatusLabel,
    getQuoteDiffPct: getSwapQuoteDiffPct,
    reset: resetSwapQuoteState,
    requestQuotes: requestSwapQuotes,
    selectProvider: selectSwapQuote,
  } = useSwapQuotesParallel({
    amountField: 'amountOut',
    compare: 'max',
    buildTxPlanForQuote: quote => buildCollateralSwapPlanFromQuote(quote),
    getStateOverrideOptions: () => buildCollateralStateOverrideOptions(),
    // Sweep-scoped plugin prefetch — Hermes pull + keyring read happen once per
    // sweep instead of once per quote.
    prefetchPluginData: (plan, _account) => prefetchPluginData(plan, { account: freshAccount.value }),
  })

  async function buildCollateralSwapPlanFromQuote(quote: SwapQuote): Promise<TransactionPlan> {
    if (!collateralVault.value?.address || !asset.value?.address) {
      throw new Error('Collateral vault not loaded')
    }
    return options.buildSwapPlan(quote, {
      vaultAddress: collateralVault.value.address,
      amountNano: valueToNano(amount.value || '0', asset.value.decimals),
      slippage: swapSlippage.value,
      subAccount: position.value?.subAccount,
    })
  }
  // --- Position/vault computeds ---
  const position = computed(() => getPositionBySubAccountIndex(+positionIndex))
  const isPositionLoaded = computed(() => !!position.value)
  const collateralVault = computed<EVault | SecuritizeCollateralVault | undefined>(() =>
    (selectedCollateral.value || (position.value ? position.value.collateralVault : undefined)) as EVault | SecuritizeCollateralVault | undefined,
  )
  const borrowVault = computed<EVault | undefined>(() => position.value ? position.value.borrowVault as EVault | undefined : undefined)
  const collateralAssets = computed(() => selectedCollateralAssets.value)
  const asset = computed(() => collateralVault.value?.asset)

  const priceInvert = usePriceInvert(
    () => collateralVault.value?.asset.symbol,
    () => borrowVault.value?.asset.symbol,
  )

  // --- APY block ---
  const collateralSupplyRewardApy = computed(() => getSupplyRewardApy(collateralVault.value?.address || ''))
  const borrowRewardApy = computed(() => getBorrowRewardApy(borrowVault.value?.address || '', collateralVault.value?.address || ''))
  const collateralSupplyApy = computed(() => {
    if (!collateralVault.value) return 0
    return withVaultIntrinsicApy(
      getVaultSupplyApy(collateralVault.value),
      collateralVault.value,
      enableIntrinsicApy.value,
    )
  })
  const borrowApy = computed(() => withVaultIntrinsicApy(
    getVaultBorrowApy(borrowVault.value),
    borrowVault.value,
    enableIntrinsicApy.value,
  ))

  const getCollateralValueUsdLocal = async (amt: bigint) => {
    if (!borrowVault.value || !collateralVault.value) return 0
    return getCollateralUsdValueOrZero(amt, borrowVault.value, collateralVault.value as EVault, 'off-chain')
  }

  const netAPY = ref(0)

  watchEffect(async () => {
    if (!position.value || !borrowVault.value || !collateralVault.value) {
      netAPY.value = 0
      return
    }

    const [collateralUsd, borrowedUsd] = await Promise.all([
      getCollateralValueUsdLocal(collateralAssets.value),
      getAssetUsdValueOrZero(position.value.borrowed ?? 0n, borrowVault.value, 'off-chain'),
    ])

    netAPY.value = getNetAPY(
      collateralUsd,
      collateralSupplyApy.value,
      borrowedUsd,
      borrowApy.value,
      collateralSupplyRewardApy.value || null,
      borrowRewardApy.value || null,
    )
  })

  // --- FixedPoint computeds ---
  const amountFixed = computed(() => FixedPoint.fromValue(
    valueToNano(amount.value || '0', collateralVault.value?.asset.decimals),
    Number(collateralVault.value?.asset.decimals),
  ))
  const borrowedFixed = computed(() => FixedPoint.fromValue(position.value?.borrowed || 0n, borrowVault.value?.shares.decimals || 18))
  const suppliedFixed = computed(() => FixedPoint.fromValue(collateralAssets.value, collateralVault.value?.asset.decimals || 18))
  const priceFixed = computed(() => {
    if (!position.value) return FixedPoint.fromValue(0n, 18)
    return options.computePriceFixed(position.value, borrowVault.value, collateralVault.value)
  })
  const liquidationPrice = computed(() => {
    if (!position.value) return undefined
    return options.computeLiquidationPrice(position.value, borrowVault.value, collateralVault.value)
  })
  const estimateLiquidationPrice = computed(() => {
    const health = nanoToValue(estimateHealth.value, 18)
    if (!health || health < 1 || health > 1e15) return undefined
    const price = priceFixed.value.toUnsafeFloat()
    if (!price) return undefined
    return price / health
  })

  // --- Collateral loading ---
  const getSelectedCollateralAddress = () =>
    (typeof route.query.collateral === 'string' ? route.query.collateral : '')

  const loadSelectedCollateral = async () => {
    if (!position.value) {
      selectedCollateral.value = null
      selectedCollateralAssets.value = 0n
      return
    }

    const primaryCollateral = position.value.collateralVault
    const primaryAddress = normalizeAddressOrEmpty(primaryCollateral?.address)
    const targetAddress = normalizeAddressOrEmpty(getSelectedCollateralAddress()) || primaryAddress

    if (targetAddress !== lastCollateralAddress.value) {
      amount.value = ''
      lastCollateralAddress.value = targetAddress
    }

    selectedCollateralAssets.value = targetAddress === primaryAddress ? position.value.supplied : 0n

    try {
      if (!isEulerAddressesReady.value) {
        await loadEulerConfig()
      }

      await until(isVaultsReady).toBe(true)

      const vault = await getOrFetch(targetAddress) as EVault | SecuritizeCollateralVault | undefined
      selectedCollateral.value = vault || null

      const lensAddress = eulerLensAddresses.value?.accountLens
      if (!lensAddress) {
        throw new Error('Account lens address is not available')
      }

      const res = await rpcClient.value!.readContract({
        address: lensAddress as Address,
        abi: eulerAccountLensABI as Abi,
        functionName: 'getVaultAccountInfo',
        args: [position.value.subAccount, targetAddress],
      }) as Record<string, unknown>
      selectedCollateralAssets.value = res.assets as bigint
    }
    catch (e) {
      logWarn(`collateral/${options.mode}`, e)
      if (!selectedCollateral.value) {
        selectedCollateral.value = primaryCollateral as EVault | SecuritizeCollateralVault | null
      }
    }
  }

  // --- Swap helpers ---
  const swapEstimatedOutput = computed(() => {
    const outputAsset = options.getSwapOutputAsset()
    if (!swapEffectiveQuote.value || !outputAsset) return ''
    const amountOut = BigInt(swapEffectiveQuote.value.amountOut || 0)
    if (amountOut <= 0n) return ''
    return formatUnits(amountOut, Number(outputAsset.decimals))
  })

  const swapInputDisplay = computed(() => {
    if (!swapEffectiveQuote.value) return ''
    const amountIn = BigInt(swapEffectiveQuote.value.amountIn || 0)
    if (amountIn <= 0n) return ''
    const tokenIn = swapEffectiveQuote.value.tokenIn
    return `${formatSmartAmount(formatUnits(amountIn, tokenIn.decimals))} ${tokenIn.symbol}`
  })

  const swapOutputDisplay = computed(() => {
    const outputAsset = options.getSwapOutputAsset()
    if (!swapEffectiveQuote.value || !outputAsset) return ''
    const amountOut = BigInt(swapEffectiveQuote.value.amountOut || 0)
    if (amountOut <= 0n) return ''
    return `${formatSmartAmount(formatUnits(amountOut, Number(outputAsset.decimals)))} ${outputAsset.symbol}`
  })

  const swapRoutedVia = computed(() => {
    if (!swapSelectedProvider.value) return 'Not selected'
    if (!swapEffectiveQuote.value?.route?.length) return null
    return swapEffectiveQuote.value.route.map((r: { providerName: string }) => r.providerName).join(', ')
  })

  const { priceImpact: swapPriceImpact } = useSwapPriceImpact({
    quote: swapEffectiveQuote,
    fromVault: computed(() => options.mode === 'withdraw' ? collateralVault.value as EVault | SecuritizeCollateralVault : null),
    toVault: computed(() => options.mode === 'supply' ? collateralVault.value as EVault | SecuritizeCollateralVault : null),
  })

  const shouldGateUnknownPriceImpact = computed(() =>
    options.needsSwap.value
    && swapEffectiveQuote.value !== null
    && swapPriceImpact.value === null,
  )
  const { guardWithPriceImpact } = usePriceImpactGate({
    directPriceImpact: swapPriceImpact,
    shouldGateUnknown: shouldGateUnknownPriceImpact,
  })

  const swapRouteItems = computed(() => {
    const outputAsset = options.getSwapOutputAsset()
    if (!outputAsset) return []
    return buildSwapRouteItems({
      quoteCards: swapQuoteCardsSorted.value,
      getQuoteDiffPct: getSwapQuoteDiffPct,
      decimals: Number(outputAsset.decimals),
      symbol: outputAsset.symbol,
      formatAmount: formatSmartAmount,
    })
  })

  const requestSwapQuote = useDebounceFn(async () => {
    swapQuoteError.value = null

    if (!options.needsSwap.value || !amount.value || !asset.value) {
      resetSwapQuoteState()
      return
    }

    const inputAmountNano = valueToNano(amount.value || '0', asset.value.decimals)
    if (inputAmountNano <= 0n) {
      resetSwapQuoteState()
      return
    }

    const userAddr = (address.value || zeroAddress) as Address
    const subAccountAddr = position.value?.subAccount
      ? (position.value.subAccount as Address)
      : userAddr

    const params = options.requestSwapQuoteParams({
      userAddr,
      subAccountAddr,
      amountNano: inputAmountNano,
      slippage: swapSlippage.value,
      asset: asset.value,
      vaultAddress: collateralVault.value?.address || '',
    })

    if (!params) {
      resetSwapQuoteState()
      return
    }

    await requestSwapQuotes(params)
  }, 500)

  const openSwapTokenSelector = (currentAddress?: string, onSelect?: (a: VaultAsset, meta?: SwapTokenSelectMeta) => void) => {
    modal.open(SwapTokenSelector, {
      props: {
        currentAssetAddress: currentAddress || asset.value?.address,
        onSelect: onSelect || (() => {}),
        mode: options.mode === 'withdraw' ? 'output' : 'input',
        allowNativeCurrency: options.mode === 'supply',
        pairedAsset: collateralVault.value?.asset,
      },
    })
  }

  const openSlippageSettings = () => {
    modal.open(SlippageSettingsModal)
  }

  const onRefreshSwapQuotes = () => {
    resetSwapQuoteState()
    requestSwapQuote()
  }

  // --- Validation computeds ---
  const isGeoBlocked = computed(() => {
    const addresses: string[] = []
    if (borrowVault.value) addresses.push(borrowVault.value.address)
    if (collateralVault.value) addresses.push(collateralVault.value.address)
    return isAnyVaultBlockedByCountry(...addresses)
  })

  const isSwapRestricted = computed(() =>
    options.needsSwap.value && isVaultRestrictedByCountry(
      collateralVault.value?.address || '',
      { counterpart: options.effectiveAsset.value },
    ),
  )

  // Asset-level geo checks for swap flows. The user-selected swap input (pay-with)
  // and/or output (receive-as) can be arbitrary ERC-20 tokens not tied to any
  // vault, so vault-level checks above won't see them. Hard-block always applies;
  // soft-restrict applies only to the "acquire" side (output). Pass the full
  // asset object so symbol/name pattern rules are also consulted.
  //
  // Input-side check is scoped to supply mode: in withdraw, `effectiveAsset`
  // is the collateral vault's own underlying, which `isGeoBlocked` above
  // already covers via the vault-level OR. Re-checking there would disable
  // submit with no corresponding toast (withdraw.vue's disabledReasonInfo
  // doesn't consult this flag).
  const isInputAssetBlocked = computed(() =>
    options.mode === 'supply'
    && options.needsSwap.value
    && isAssetBlockedByCountry(options.effectiveAsset.value),
  )
  const isOutputAssetBlocked = computed(() =>
    options.needsSwap.value && isAssetBlockedByCountry(options.getSwapOutputAsset()),
  )
  const isOutputAssetRestricted = computed(() =>
    options.needsSwap.value
    && isAssetRestrictedByCountry(options.getSwapOutputAsset(), { counterpart: options.effectiveAsset.value }),
  )

  const collateralOp = computed(() => options.mode === 'supply' ? OP_DEPOSIT : OP_WITHDRAW)

  const hookWarning = computed(() => {
    // Securitize collateral doesn't implement hooks — skip non-EVaults.
    if (!collateralVault.value || !isEVault(collateralVault.value)) return null
    return getHookDisabledWarning(collateralVault.value, collateralOp.value)
  })

  const isSubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (collateralVault.value && isEVault(collateralVault.value) && isOpDisabled(collateralVault.value, collateralOp.value)) return true
    if (options.effectiveBalance.value < valueToNano(amount.value, options.effectiveAsset.value?.decimals)) return true
    if (isLoading.value || !(+amount.value) || !!estimatesError.value || isEstimatesLoading.value) return true
    if (options.needsSwap.value && !swapSelectedQuote.value) return true
    return false
  })

  const submitDisabled = computed(() =>
    isGeoBlocked.value
    || isSwapRestricted.value
    || isInputAssetBlocked.value
    || isOutputAssetBlocked.value
    || isOutputAssetRestricted.value
    || isLoading.value
    || isSubmitDisabled.value,
  )

  // --- Estimates ---
  const updateSyncEstimates = () => {
    clearSimulationError()
    estimatesError.value = ''
    if (!collateralVault.value) return

    try {
      // Derive total collateral value from position's on-chain LTV (multi-collateral aware),
      // then adjust for the collateral delta using the single collateral's price.
      const totalValue = getTotalCollateralValue(position.value!)
      const borrowed18 = borrowedFixed.value.round(18)
      const amount18 = amountFixed.value.round(18)
      const supplied18 = suppliedFixed.value.round(18)
      const priceFl = priceFixed.value.toUnsafeFloat()
      const amountFl = amount18.toUnsafeFloat()

      // Only apply delta if this collateral is accepted by the controller (BLTV > 0)
      const affectsLtv = borrowVault.value?.collaterals.some(
        ltv => ltv.address.toLowerCase() === collateralVault.value!.address.toLowerCase() && ltv.borrowLTV > 0,
      ) ?? false

      const collateralValueFl = totalValue !== null && priceFl > 0
        ? (options.mode === 'supply'
            ? totalValue + (affectsLtv ? amountFl * priceFl : 0)
            : totalValue - (affectsLtv ? amountFl * priceFl : 0))
        : (options.mode === 'supply'
            ? supplied18.add(amount18).mul(priceFixed.value).toUnsafeFloat()
            : supplied18.sub(amount18).mul(priceFixed.value).toUnsafeFloat())

      const collateralValue = FixedPoint.fromValue(
        BigInt(Math.round(collateralValueFl * 1e18)),
        18,
      )

      const userLtvFixed = collateralValue.isZero()
        ? FixedPoint.fromValue(0n, 18)
        : borrowed18
            .div(collateralValue)
            .mul(FixedPoint.fromValue(100n, 0))

      options.validateEstimate({
        amountFixed: amountFixed.value,
        suppliedFixed: suppliedFixed.value,
        borrowedFixed: borrowedFixed.value,
        priceFixed: priceFixed.value,
        collateralValue,
        userLtvFixed,
        needsSwap: options.needsSwap.value,
      })

      estimateUserLTV.value = userLtvFixed.value
      // liquidationLTV is in basis points (e.g. 8600 = 86%). Convert to 18-decimal
      // percentage (8600 * 10^16 = 86 * 10^18) to match userLtvFixed's 18 decimals.
      const effectiveLiquidationLtv = getBorrowPositionEffectiveLiquidationLTV(position.value!)
      if (effectiveLiquidationLtv === undefined) throw new Error('Liquidation LTV unavailable')
      const liquidationLtvBps = decimalLtvToBps(effectiveLiquidationLtv)
      estimateHealth.value = (userLtvFixed.isZero() || userLtvFixed.isNegative())
        ? 0n
        : FixedPoint.fromValue(liquidationLtvBps * (10n ** 16n), 18).div(userLtvFixed).value
    }
    catch (e: unknown) {
      logWarn('collateral/syncEstimates', e)
      estimateUserLTV.value = position.value!.userLTV ?? position.value!.currentLTV ?? 0n
      estimateHealth.value = position.value!.healthFactor ?? 0n
      estimatesError.value = (e as { message: string }).message
    }
  }

  const asyncEstimatesGuard = createRaceGuard()
  const updateAsyncEstimates = useDebounceFn(async () => {
    if (!collateralVault.value || !borrowVault.value) {
      isEstimatesLoading.value = false
      return
    }
    const gen = asyncEstimatesGuard.next()
    try {
      if (!isEVault(collateralVault.value)) return
      const evault = collateralVault.value
      const amountNano = valueToNano(amount.value, evault.asset.decimals)
      const cashDelta = options.mode === 'supply' ? amountNano : -amountNano

      const [projected, collateralUsd, borrowedUsd] = await Promise.all([
        getProjectedRates(
          evault.address,
          evault.totalCash,
          evault.totalBorrowed,
          cashDelta,
          0n,
        ),
        getCollateralValueUsdLocal(
          options.mode === 'supply'
            ? collateralAssets.value + amountNano
            : collateralAssets.value - amountNano,
        ),
        getAssetUsdValueOrZero(position.value!.borrowed || 0n, borrowVault.value!, 'off-chain'),
      ])

      if (asyncEstimatesGuard.isStale(gen)) return

      const projectedSupplyApy = projected
        ? withVaultIntrinsicApy(nanoToValue(projected.supplyAPY, 25), evault, enableIntrinsicApy.value)
        : collateralSupplyApy.value

      estimateNetAPY.value = getNetAPY(
        collateralUsd,
        projectedSupplyApy,
        borrowedUsd,
        borrowApy.value,
        collateralSupplyRewardApy.value || null,
        borrowRewardApy.value || null,
      )
    }
    catch (e) {
      if (asyncEstimatesGuard.isStale(gen)) return
      logWarn('collateral/asyncEstimates', e)
      estimateNetAPY.value = netAPY.value
    }
    finally {
      if (!asyncEstimatesGuard.isStale(gen)) {
        isEstimatesLoading.value = false
      }
    }
  }, 500)

  // --- Load ---
  const load = async () => {
    if (!isConnected.value && !isSpyMode.value) return
    isLoading.value = true
    await until(isPositionLoaded).toBe(true)
    try {
      await loadSelectedCollateral()
      await options.onAfterLoad?.()
      estimateNetAPY.value = netAPY.value
      estimateUserLTV.value = position.value!.userLTV ?? position.value!.currentLTV ?? 0n
      estimateHealth.value = position.value!.healthFactor ?? 0n
    }
    catch (e) {
      showError('Unable to load Vault')
      logWarn('collateral/load', e)
    }
    finally {
      isLoading.value = false
    }
  }

  const buildRawPlan = async (): Promise<TransactionPlan | null> => {
    if (!collateralVault.value?.address || !asset.value?.address) return null
    if (options.needsSwap.value && swapEffectiveQuote.value) {
      return options.buildSwapPlan(swapEffectiveQuote.value, {
        vaultAddress: collateralVault.value.address,
        amountNano: valueToNano(amount.value || '0', asset.value.decimals),
        slippage: swapSlippage.value,
        subAccount: position.value?.subAccount,
      })
    }
    return options.buildDirectPlan({
      vaultAddress: collateralVault.value.address,
      assetAddress: asset.value.address,
      amountNano: valueToNano(amount.value || '0', asset.value.decimals),
      subAccount: position.value?.subAccount,
    })
  }

  // --- Submit ---
  const submit = async () => {
    if (isOperationBlocked.value) return
    if (isPreparing.value
      || isGeoBlocked.value
      || isSwapRestricted.value
      || isInputAssetBlocked.value
      || isOutputAssetBlocked.value
      || isOutputAssetRestricted.value) return
    isPreparing.value = true
    try {
      await guardWithPriceImpact(async () => {
        if (!collateralVault.value?.address || !asset.value?.address) return

        plan.value = null
        preparedPlan.value = null
        try {
          const rawPlan = await buildRawPlan()
          plan.value = rawPlan
          if (rawPlan && options.usePreparedPipeline) {
            preparedPlan.value = await prepareTransactionPlan(rawPlan, { account: freshAccount.value })
          }
        }
        catch (e) {
          logWarn(`collateral/${options.mode}/buildPlan`, e)
          plan.value = null
          preparedPlan.value = null
          if (options.usePreparedPipeline) {
            // In the prepared pipeline, opening the modal with no envelope
            // would show "Transaction plan is unavailable" — surface the real
            // error inline instead.
            simulationError.value = await getTxErrorMessage(e)
            return
          }
        }

        if (options.usePreparedPipeline) {
          if (!preparedPlan.value) return
          const ok = await runPreparedSimulation(preparedPlan.value, buildCollateralStateOverrideOptions())
          if (!ok) return
        }
        else if (plan.value) {
          const ok = await runSimulation(plan.value, buildCollateralStateOverrideOptions())
          if (!ok) return
        }

        const reviewAsset = options.getReviewAsset(options.needsSwap.value)
        const reviewType = options.needsSwap.value ? options.swapReviewType : options.reviewType
        modal.open(OperationReviewModal, {
          props: {
            type: reviewType,
            asset: reviewAsset,
            amount: amount.value,
            plan: options.usePreparedPipeline ? undefined : (plan.value || undefined),
            prepared: options.usePreparedPipeline ? (preparedPlan.value || undefined) : undefined,
            subAccount: position.value?.subAccount,
            hasBorrows: (position.value?.borrowed || 0n) > 0n,
            swapToAsset: options.needsSwap.value ? options.getSwapToAsset() : undefined,
            swapToAmount: options.needsSwap.value ? swapEstimatedOutput.value : undefined,
            swapMode: options.needsSwap.value ? SwapperMode.EXACT_IN : undefined,
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

  // --- Send ---
  const send = async () => {
    try {
      isSubmitting.value = true
      if (!asset.value?.address || !collateralVault.value?.address) return

      if (options.usePreparedPipeline) {
        if (!preparedPlan.value) return
        await executePreparedPlan(preparedPlan.value)
      }
      else {
        // Legacy path rebuilds the plan at send time. Migrated forms should
        // adopt `usePreparedPipeline` to reuse the envelope created in submit().
        let txPlan: TransactionPlan
        if (options.needsSwap.value && (swapSelectedQuote.value || swapEffectiveQuote.value)) {
          const quote = swapSelectedQuote.value || swapEffectiveQuote.value!
          txPlan = await options.buildSwapPlan(quote, {
            vaultAddress: collateralVault.value.address,
            amountNano: valueToNano(amount.value || '0', asset.value.decimals),
            slippage: swapSlippage.value,
            subAccount: position.value?.subAccount,
          })
        }
        else {
          txPlan = await options.buildDirectPlan({
            vaultAddress: collateralVault.value.address,
            assetAddress: asset.value.address,
            amountNano: valueToNano(amount.value || '0', asset.value.decimals),
            subAccount: position.value?.subAccount,
          })
        }
        await executePlan(txPlan)
      }
      await finalizeTxAndRedirect({ onAfterClose: options.onAfterSend })
    }
    catch (e) {
      logWarn('collateral/send', e)
      error('Transaction failed')
    }
    finally {
      isSubmitting.value = false
    }
  }

  // Pre-prime ERC20 slot hints for the assets this form touches (collateral,
  // borrow, pay-with/output). One probe per token, owner-/spender-agnostic;
  // keeps state-override derivation off the access-list path for the lifetime
  // of the form.
  const primeFormSlotHints = () => {
    const tokens: Address[] = []
    const seen = new Set<string>()
    const push = (addr?: string) => {
      if (!addr) return
      const key = addr.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      tokens.push(addr as Address)
    }
    push(collateralVault.value?.asset?.address)
    push(borrowVault.value?.asset?.address)
    push(options.effectiveAsset.value?.address)
    push(options.getSwapOutputAsset()?.address)
    if (tokens.length) void primeSlotHintsFor(tokens)
  }

  // Register the priming watcher AFTER the synchronous construction path.
  // Consumers pass `effectiveAsset`/`getSwapOutputAsset` that close over the
  // `form` object returned by this composable (e.g. `effectiveAsset: () =>
  // form.asset.value`). Vue's `watch` evaluates its source getters once,
  // synchronously, at registration time (independent of `immediate`) to capture
  // baseline values — so listing those getters as sources here, while still on
  // the right-hand side of `const form = useCollateralForm(...)`, dereferences
  // `form` in its temporal dead zone and throws. Defer to a microtask (form is
  // assigned by then) and re-run inside the captured effect scope so the watcher
  // is still tied to the component lifecycle and auto-disposed on unmount.
  const scope = getCurrentScope()
  void Promise.resolve().then(() => {
    const register = () => watch(
      [collateralVault, borrowVault, () => options.effectiveAsset.value, () => options.getSwapOutputAsset()],
      primeFormSlotHints,
      { immediate: true },
    )
    if (scope) scope.run(register)
    else register()
  })

  // --- Common watchers ---
  watch(isPositionsLoaded, (val) => {
    if (val) load()
  }, { immediate: true })

  watch(() => route.query.collateral, async () => {
    clearSimulationError()
    if (!isPositionLoaded.value) return
    await loadSelectedCollateral()
    await options.onAfterLoad?.()
    estimateNetAPY.value = netAPY.value
    estimateUserLTV.value = position.value ? position.value.userLTV ?? position.value.currentLTV ?? 0n : 0n
    estimateHealth.value = position.value ? position.value.healthFactor ?? 0n : 0n
  })

  watch(amount, async () => {
    if (!collateralVault.value) return
    updateSyncEstimates()
    if (!isEstimatesLoading.value) {
      isEstimatesLoading.value = true
    }
    updateAsyncEstimates()
    if (options.needsSwap.value) {
      resetSwapQuoteState()
      requestSwapQuote()
    }
  })

  watch(swapSlippage, () => {
    if (options.needsSwap.value && amount.value) {
      clearSimulationError()
      resetSwapQuoteState()
      requestSwapQuote()
    }
  })

  watch(swapSelectedQuote, () => {
    clearSimulationError()
  })

  return {
    // State
    isLoading,
    isSubmitting,
    isPreparing,
    isEstimatesLoading,
    amount,
    plan,
    estimateNetAPY,
    estimateUserLTV,
    estimateHealth,
    estimateLiquidationPrice,
    estimatesError,
    selectedCollateral,
    selectedCollateralAssets,

    // Position/vault
    position,
    isPositionLoaded,
    collateralVault,
    borrowVault,
    collateralAssets,
    asset,
    priceInvert,

    // APY
    netAPY,
    collateralSupplyApy,
    borrowApy,
    collateralSupplyRewardApy,
    borrowRewardApy,

    // FixedPoint
    amountFixed,
    borrowedFixed,
    suppliedFixed,
    priceFixed,
    liquidationPrice,

    // Swap
    swapSlippage,
    swapQuoteCardsSorted,
    swapSelectedProvider,
    swapSelectedQuote,
    swapEffectiveQuote,
    swapProvidersCount,
    isSwapQuoteLoading,
    swapQuoteError,
    swapQuotesStatusLabel,
    swapEstimatedOutput,
    swapInputDisplay,
    swapOutputDisplay,
    swapRoutedVia,
    swapPriceImpact,
    swapRouteItems,
    selectSwapQuote,
    resetSwapQuoteState,
    requestSwapQuote,
    openSwapTokenSelector,
    openSlippageSettings,
    onRefreshSwapQuotes,

    // Validation
    isGeoBlocked,
    isSwapRestricted,
    isInputAssetBlocked,
    isOutputAssetBlocked,
    isOutputAssetRestricted,
    isSubmitDisabled,
    submitDisabled,
    submitLabel,
    hookWarning,
    simulationError,
    clearSimulationError,

    // Actions
    loadSelectedCollateral,
    submit,
    send,
    updateEstimates: () => {
      updateSyncEstimates()
      updateAsyncEstimates()
    },
  }
}
