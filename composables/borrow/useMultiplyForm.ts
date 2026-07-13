import type { EVault, SwapQuote, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { areProjectedRatesComplete, type ProjectedRates, getNetAPY, getPositionMultiplier, getProjectedRatesBatch, getRoe } from '~/utils/vault/apy'
import { getAssetUsdValue, getAssetUsdValueOrZero, getAssetOraclePrice, getCollateralOraclePrice, getCollateralShareOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { computeMultipliedPriceImpact } from '~/utils/priceImpact'
import { computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { computeMaxMultiplier, computeMinMultiplier, computeWeightedSupplyApy, computeLeverageDebt } from '~/utils/multiply-math'
import { getPlanHookDisabledWarning, getUtilisationWarning, getSupplyCapWarning, getBorrowCapWarning } from '~/composables/useVaultWarnings'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { useMultiplyCollateralOptions } from '~/composables/useMultiplyCollateralOptions'
import { withProjectedVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { findBlockingDisabledOp, OP_BORROW, OP_DEPOSIT, OP_SKIM, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { formatUnits, zeroAddress, type Address } from 'viem'
import { OperationReviewModal } from '#components'
import { profAsync, profMark } from '~/utils/profiler'
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
import { useStateOverrideOptions } from '~/composables/useStateOverrideOptions'

// Snapshot of all multiply inputs captured at "add to batch" time. The batch
// re-simulates asynchronously (after the form may reset), so the plan must be
// built from these captured values rather than the live reactive refs.
export interface MultiplyBatchSnapshot {
  subAccount: Address
  supplyVault: EVault
  longVault: EVault
  shortVault: EVault
  inputAmount: string
  debtAmount: bigint
  isSavingCollateral: boolean
  savingFrom?: Address
  savingAssets?: bigint
  savingShares?: bigint
  quote?: SwapQuote
}

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
  const { planMultiply, prepareTransactionPlan, prefetchPluginData, executePlan, preloadSubAccountSnapshot } = useEulerTx()
  const { isConnected, isSpyMode, effectiveAddress } = useEffectiveAddress()
  // State-override knobs: skip balance probing (form validates "Not enough
  // balance"), pass current wallet snapshot, and pre-prime slot hints when the
  // relevant assets resolve.
  const { primeSlotHintsFor, buildStateOverrideOptions } = useStateOverrideOptions()
  const buildMultiplyStateOverrideOptions = () => buildStateOverrideOptions({ noBalanceOverride: true })
  const { depositPositions } = useEulerAccount()
  const { account: planAccount } = usePlanAccount()
  const { chainId } = useEulerAddresses()
  const { getBalance } = useWallets()
  const { finalizeTxAndRedirect } = useTxFinalization()
  const { entryCount: batchEntryCount } = useTxBatch()
  const {
    getSupplyRewardApy,
    getBorrowRewardApyForCollaterals,
    getEligibleLoopingRewardApyForCollaterals,
  } = useRewardsApy()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const {
    runPreparedSimulation: runMultiplySimulation,
    simulationError: multiplySimulationError,
    clearSimulationError: clearMultiplySimulationError,
  } = useTransactionPlanSimulation()

  // --- Form state ---
  const multiplyInputAmount = ref('')
  const multiplier = ref(1)
  const multiplyLongAmount = ref('')
  const multiplyShortAmount = ref('')
  const multiplySupplyVault: Ref<EVault | undefined> = ref()
  // Supply-asset wallet balance from the central wallet entity — reactive + layer-aware.
  const multiplyAssetBalance = computed(() => multiplySupplyVault.value?.asset.address ? getBalance(multiplySupplyVault.value.asset.address as Address) : 0n)
  const isMultiplySavingCollateral = ref(false)
  // Sub-account of the savings position the user picked from the collateral
  // options modal. Without this, two savings positions of the same vault on
  // different sub-accounts look identical to `depositPositions.find(...)` and
  // the form silently sources shares from whichever happened to be first.
  const multiplySelectedSavingSubAccount = ref<string | undefined>(undefined)
  const isMultiplySubmitting = ref(false)
  const isMultiplyPreparing = ref(false)
  const multiplyPlan = ref<TransactionPlan | null>(null)
  const preparedMultiplyPlan = shallowRef<TransactionPlanPrepared | null>(null)

  const multiplyPriceInvert = usePriceInvert(
    () => multiplyShortVault.value?.asset.symbol,
    () => multiplyLongVault.value?.asset.symbol,
  )

  const { slippage: multiplySlippage } = useSlippage({
    enabled: () => _formTab.value === 'multiply',
    fromSymbol: () => borrowVault.value?.asset.symbol,
    toSymbol: () => collateralVault.value?.asset.symbol,
  })
  const {
    sortedQuoteCards: multiplyQuoteCardsSorted,
    selectedProvider: multiplySelectedProvider,
    selectedQuote: multiplySelectedQuote,
    selectedQuoteCard: multiplySelectedQuoteCard,
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
  } = useSwapQuotesParallel({
    amountField: 'amountOut',
    compare: 'max',
    includeCowSwap: () => batchEntryCount.value === 0 && !isMultiplySavingCollateral.value,
    buildTxPlanForQuote: (quote, _provider, context) => buildMultiplyPlanFromQuote(quote, context.account),
    getStateOverrideOptions: () => buildMultiplyStateOverrideOptions(),
    // First quote in each sweep computes plugin prefetch (Pyth Hermes updates
    // + keyring vault gating) from its plan; the rest of the sweep reuses it.
    getPlanAccount: () => planAccount.value,
    prefetchPluginData: (plan, account) => prefetchPluginData(plan, { account }),
  })

  async function buildMultiplyPlanFromQuote(quote: SwapQuote, account = planAccount.value): Promise<TransactionPlan> {
    if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value) {
      throw new Error('Multiply vaults not loaded')
    }
    const debtAmount = multiplyDebtAmountNano.value
    if (debtAmount <= 0n) throw new Error('Debt amount not set')
    const supplyAmountNano = valueToNano(multiplyInputAmount.value || '0', multiplySupplyVault.value.asset.decimals)
    let supplySharesAmount: bigint | undefined
    if (isMultiplySavingCollateral.value && multiplySavingPosition.value) {
      supplySharesAmount = multiplySavingPosition.value.assets === supplyAmountNano
        ? multiplySavingBalance.value
        : multiplySupplyVault.value.convertToShares(supplyAmountNano)
    }
    const collateralShareSource = isMultiplySavingCollateral.value && supplySharesAmount && multiplySavingPosition.value
      ? { from: multiplySavingPosition.value.subAccount as Address, shares: supplySharesAmount }
      : undefined
    const collateralAmount = isMultiplySavingCollateral.value ? 0n : supplyAmountNano
    const receiver = (quote.accountIn || effectiveAddress.value || zeroAddress) as Address
    return planMultiply({
      collateralVault: multiplySupplyVault.value.address as Address,
      collateralAmount,
      collateralAsset: multiplySupplyVault.value.asset.address as Address,
      collateralShareSource,
      longVault: multiplyLongVault.value.address as Address,
      liabilityVault: multiplyShortVault.value.address as Address,
      liabilityAmount: debtAmount,
      receiver,
      swapQuote: quote,
      swapperMode: SwapperMode.EXACT_IN,
      account,
      subAccountSnapshotApplied: Boolean(account),
    })
  }

  // Build this multiply for the batch ("shopping cart"), against the prior layer's
  // simulated `account`. Mirrors submitMultiply's plan build but from a captured
  // snapshot (the batch re-simulates after the form resets) and forces
  // subAccountSnapshotApplied so the layer account stays authoritative (no
  // on-chain re-fetch). Same-asset multiply passes no quote; cross-asset needs a
  // non-CoW quote (gated at the call site). New position ⇒ a fresh sub-account.
  const buildMultiplyPlan = async (snap: MultiplyBatchSnapshot, account = planAccount.value): Promise<TransactionPlan> => {
    const subAccount = snap.subAccount
    const supplyAmountNano = valueToNano(snap.inputAmount || '0', snap.supplyVault.asset.decimals)
    let supplyShares: bigint | undefined
    if (snap.isSavingCollateral && snap.savingFrom) {
      supplyShares = snap.savingAssets === supplyAmountNano
        ? snap.savingShares
        : snap.supplyVault.convertToShares(supplyAmountNano)
    }
    const collateralShareSource = snap.isSavingCollateral && supplyShares && snap.savingFrom
      ? { from: snap.savingFrom, shares: supplyShares }
      : undefined
    const collateralAmount = snap.isSavingCollateral ? 0n : supplyAmountNano
    return planMultiply({
      collateralVault: snap.supplyVault.address as Address,
      collateralAmount,
      collateralAsset: snap.supplyVault.asset.address as Address,
      collateralShareSource,
      longVault: snap.longVault.address as Address,
      liabilityVault: snap.shortVault.address as Address,
      liabilityAmount: snap.debtAmount,
      receiver: subAccount,
      swapQuote: snap.quote,
      swapperMode: SwapperMode.EXACT_IN,
      account,
      subAccountSnapshotApplied: true,
    })
  }
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
  // Fail-closed when multiple savings positions match the supply vault but no
  // sub-account is selected. Returning the first match silently is the bug
  // dev's PR #436 fixed.
  const multiplySavingPosition = computed(() => {
    if (!multiplySupplyVault.value) return null
    const supplyAddr = normalizeAddress(multiplySupplyVault.value.address)
    const matches = depositPositions.value.filter(
      position => position.vault && normalizeAddress(position.vault.address) === supplyAddr,
    )
    if (matches.length === 0) return null
    const wantedSub = multiplySelectedSavingSubAccount.value
    if (wantedSub) {
      const target = normalizeAddress(wantedSub)
      return matches.find(p => normalizeAddress(p.subAccount) === target) ?? null
    }
    return matches.length === 1 ? matches[0] : null
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
  const multiplySupplyValueGuard = createRaceGuard()
  const multiplyLongValueGuard = createRaceGuard()
  const multiplyBorrowValueGuard = createRaceGuard()

  watchEffect(async () => {
    const gen = multiplySupplyValueGuard.next()
    const vault = multiplySupplyVault.value
    const amount = multiplySupplyAmountNano.value
    if (!vault || !amount) {
      multiplySupplyValueUsd.value = null
      return
    }
    const value = await getAssetUsdValueOrZero(amount, vault, 'off-chain')
    if (!multiplySupplyValueGuard.isStale(gen)) multiplySupplyValueUsd.value = value
  })

  watchEffect(async () => {
    const gen = multiplyLongValueGuard.next()
    const vault = multiplyLongVault.value
    const amount = multiplySwapAmountOut.value
    if (!vault || !amount) {
      multiplyLongValueUsd.value = null
      return
    }
    const value = await getAssetUsdValueOrZero(amount, vault, 'off-chain')
    if (!multiplyLongValueGuard.isStale(gen)) multiplyLongValueUsd.value = value
  })

  watchEffect(async () => {
    const gen = multiplyBorrowValueGuard.next()
    const vault = multiplyShortVault.value
    const amount = multiplyDebtAmountNano.value
    if (!vault || !amount) {
      multiplyBorrowValueUsd.value = null
      return
    }
    const value = await getAssetUsdValueOrZero(amount, vault, 'off-chain')
    if (!multiplyBorrowValueGuard.isStale(gen)) multiplyBorrowValueUsd.value = value
  })

  const multiplyTotalSupplyUsd = computed(() => {
    if (multiplySupplyValueUsd.value === null) return null
    return multiplySupplyValueUsd.value + (multiplyLongValueUsd.value || 0)
  })

  // --- Projected rates ---
  const projectedSupplyRates = ref<ProjectedRates | null>(null)
  const projectedLongRates = ref<ProjectedRates | null>(null)
  const projectedBorrowRates = ref<ProjectedRates | null>(null)
  const projectedRatesComplete = ref(false)
  const projectedRatesGuard = createRaceGuard()

  watchEffect(async () => {
    const supply = multiplySupplyVault.value
    const short = multiplyShortVault.value
    const long = multiplyLongVault.value
    const supplyNano = multiplySupplyAmountNano.value
    const upfrontSupplyNano = isMultiplySavingCollateral.value ? 0n : supplyNano
    const debtNano = multiplyDebtAmountNano.value
    const swapOut = multiplySwapAmountOut.value
    const gen = projectedRatesGuard.next()

    if (!supply || !short || !long || !supplyNano || !debtNano) {
      projectedSupplyRates.value = null
      projectedLongRates.value = null
      projectedBorrowRates.value = null
      projectedRatesComplete.value = false
      return
    }

    projectedRatesComplete.value = false

    try {
      const supplyAndLongSameVault = normalizeAddress(supply.address) === normalizeAddress(long.address)

      if (supplyAndLongSameVault) {
        // Combined delta for supply + long vault
        const projectedRates = await getProjectedRatesBatch([
          { vaultAddress: supply.address, currentCash: supply.totalCash, currentBorrows: supply.totalBorrowed, cashDelta: upfrontSupplyNano + swapOut, borrowsDelta: 0n },
          { vaultAddress: short.address, currentCash: short.totalCash, currentBorrows: short.totalBorrowed, cashDelta: -debtNano, borrowsDelta: debtNano },
        ])
        if (projectedRatesGuard.isStale(gen)) return
        if (!areProjectedRatesComplete(projectedRates, 2)) return
        const [combined, shortResult] = projectedRates
        projectedSupplyRates.value = combined
        projectedLongRates.value = combined
        projectedBorrowRates.value = shortResult
        projectedRatesComplete.value = true
      }
      else {
        const projectedRates = await getProjectedRatesBatch([
          { vaultAddress: supply.address, currentCash: supply.totalCash, currentBorrows: supply.totalBorrowed, cashDelta: upfrontSupplyNano, borrowsDelta: 0n },
          { vaultAddress: short.address, currentCash: short.totalCash, currentBorrows: short.totalBorrowed, cashDelta: -debtNano, borrowsDelta: debtNano },
          { vaultAddress: long.address, currentCash: long.totalCash, currentBorrows: long.totalBorrowed, cashDelta: swapOut, borrowsDelta: 0n },
        ])
        if (projectedRatesGuard.isStale(gen)) return
        if (!areProjectedRatesComplete(projectedRates, 3)) return
        const [supplyResult, shortResult, longResult] = projectedRates
        projectedSupplyRates.value = supplyResult
        projectedLongRates.value = longResult
        projectedBorrowRates.value = shortResult
        projectedRatesComplete.value = true
      }
    }
    catch (e) {
      if (projectedRatesGuard.isStale(gen)) return
      logWarn('multiply/projectedRates', e)
      projectedSupplyRates.value = null
      projectedLongRates.value = null
      projectedBorrowRates.value = null
      projectedRatesComplete.value = false
    }
  })

  // --- APYs ---
  const multiplySupplyApy = computed(() => {
    if (!multiplySupplyVault.value || !projectedRatesComplete.value) return null
    const currentRaw = getVaultSupplyApy(multiplySupplyVault.value)
    const projectedRaw = projectedSupplyRates.value ? nanoToValue(projectedSupplyRates.value.supplyAPY, 25) : null
    return withProjectedVaultIntrinsicApy(currentRaw, projectedRaw, multiplySupplyVault.value, enableIntrinsicApy.value)
      + getSupplyRewardApy(multiplySupplyVault.value.address)
  })

  const multiplyLongApy = computed(() => {
    if (!multiplyLongVault.value || !projectedRatesComplete.value) return null
    const currentRaw = getVaultSupplyApy(multiplyLongVault.value)
    const projectedRaw = projectedLongRates.value ? nanoToValue(projectedLongRates.value.supplyAPY, 25) : null
    return withProjectedVaultIntrinsicApy(currentRaw, projectedRaw, multiplyLongVault.value, enableIntrinsicApy.value)
      + getSupplyRewardApy(multiplyLongVault.value.address)
  })

  const multiplyBorrowApy = computed(() => {
    if (!multiplyShortVault.value || !projectedRatesComplete.value) return null
    const currentRaw = getVaultBorrowApy(multiplyShortVault.value)
    const projectedRaw = projectedBorrowRates.value ? nanoToValue(projectedBorrowRates.value.borrowAPY, 25) : null
    return withProjectedVaultIntrinsicApy(currentRaw, projectedRaw, multiplyShortVault.value, enableIntrinsicApy.value)
  })

  const multiplyCollateralAddresses = computed(() => [
    multiplySupplyVault.value?.address,
    multiplyLongVault.value?.address,
  ].filter(Boolean) as string[])

  const multiplyBorrowRewardApy = computed(() =>
    multiplyShortVault.value
      ? getBorrowRewardApyForCollaterals(multiplyShortVault.value.address, multiplyCollateralAddresses.value)
      : 0,
  )

  const multiplyLoopingRewardApy = computed(() =>
    multiplyShortVault.value
      ? getEligibleLoopingRewardApyForCollaterals(
          multiplyShortVault.value.address,
          multiplyCollateralAddresses.value,
          getPositionMultiplier(multiplyTotalSupplyUsd.value, multiplyBorrowValueUsd.value),
        )
      : 0,
  )

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
    return null
  })

  const multiplyRoeAfter = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (
      multiplyTotalSupplyUsd.value === null
      || multiplyBorrowValueUsd.value === null
      || multiplyWeightedSupplyApy.value === null
      || multiplyBorrowApy.value === null
    ) return null
    return getRoe(
      multiplyTotalSupplyUsd.value,
      multiplyWeightedSupplyApy.value,
      multiplyBorrowValueUsd.value,
      multiplyBorrowApy.value,
      null,
      multiplyBorrowRewardApy.value || null,
      multiplyLoopingRewardApy.value || null,
    )
  })

  const multiplyNetApyAfter = computed(() => {
    if (isMultiplyQuoteLoading.value) return null
    if (
      multiplyTotalSupplyUsd.value === null
      || multiplyBorrowValueUsd.value === null
      || multiplyWeightedSupplyApy.value === null
      || multiplyBorrowApy.value === null
    ) return null
    return getNetAPY(
      multiplyTotalSupplyUsd.value,
      multiplyWeightedSupplyApy.value,
      multiplyBorrowValueUsd.value,
      multiplyBorrowApy.value,
      null,
      multiplyBorrowRewardApy.value || null,
      multiplyLoopingRewardApy.value || null,
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

  const multiplyCapErrorText = computed(() => {
    if (isSupplyCapReached.value && multiplySupplyVault.value) {
      return getSupplyCapWarning(multiplySupplyVault.value)?.message || 'The supply cap has been reached. New deposits will fail.'
    }
    if (isBorrowCapReached.value && multiplyShortVault.value) {
      return getBorrowCapWarning(multiplyShortVault.value)?.message || 'The borrow cap has been reached. New borrows will fail.'
    }
    return null
  })

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
    // Disconnected wallets fall through to enable the connect-wallet button.
    // Spy mode has a "wallet" (the spied address) so it must run the same
    // disabling logic — no quote selected, missing amount, etc.
    if (!isConnected.value && !isSpyMode.value) return false
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
    if (!multiplySupplyVault.value || !multiplyShortVault.value) return []
    return [
      getPlanHookDisabledWarning(multiplyPlannedOps.value),
      getSupplyCapWarning(multiplySupplyVault.value),
      getUtilisationWarning(multiplyShortVault.value, 'borrow'),
      getBorrowCapWarning(multiplyShortVault.value),
    ]
  })

  // --- Swap quote ---
  const requestMultiplyQuote = useDebounceFn(async () => {
    profMark('multiplyForm', 'requestMultiplyQuote.fire')
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
      account = (await profAsync('multiplyForm', 'requestQuote.resolvePendingSubAccount', () => resolvePendingSubAccount())) as Address
    }
    catch {
      resetMultiplyQuoteState()
      multiplyQuoteError.value = 'Unable to resolve position'
      return
    }

    if (planAccount.value) {
      try {
        await profAsync('multiplyForm', 'requestQuote.preloadSubAccountSnapshot', () => preloadSubAccountSnapshot(planAccount.value!, account))
      }
      catch (e) {
        logWarn('multiply/preloadSubAccountSnapshot', e)
      }
    }

    // CoW open position uses a compatible empty sub-account because the
    // wrapper enables the borrow vault controller itself. Resolve it here so
    // the CoW quote is scoped to it; if unavailable we fall back to skipping
    // the CoW provider.
    const shouldRequestCowSwap = batchEntryCount.value === 0 && !isMultiplySavingCollateral.value
    const quoteDeadline = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
    const cowProviderExtraData = { ...COWSWAP_PROVIDER_EXTRA_DATA.openPosition }
    let cowAccount: Address | null = null
    const chainConfig = getCowSwapChainConfig(chainId.value ?? 0)
    const cowOwner = effectiveAddress.value as Address | undefined
    if (shouldRequestCowSwap && chainConfig && cowOwner) {
      try {
        cowAccount = await getNewSubAccount(cowOwner, multiplyShortVault.value.address) as Address
      }
      catch (e) {
        logWarn('multiply/cowswap/resolveQuoteSubaccount', e)
      }
    }
    if (shouldRequestCowSwap && chainConfig && cowAccount && cowOwner) {
      cowProviderExtraData.appData = buildOpenPositionQuoteAppData(
        {
          owner: cowOwner,
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
    await profAsync('multiplyForm', 'requestMultiplyQuotes.total', () => requestMultiplyQuotes(requestParams, {
      errorMessage: 'Unable to fetch swap quote. Multiply feature is not available for this asset.',
      providerExtraData: shouldRequestCowSwap && cowAccount ? { cow: cowProviderExtraData } : undefined,
      providerParams: shouldRequestCowSwap && cowAccount
        ? { cow: { accountIn: cowAccount, accountOut: cowAccount } }
        : undefined,
    }))
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
    const nextSubAccount = nextIsSaving ? nextOption.subAccount : undefined
    const vaultChanged = !multiplySupplyVault.value
      || normalizeAddress(multiplySupplyVault.value.address) !== normalizeAddress(nextVault.address)
    const savingChanged = nextIsSaving !== isMultiplySavingCollateral.value
    const subAccountChanged = (multiplySelectedSavingSubAccount.value ?? undefined) !== nextSubAccount
    if (vaultChanged || savingChanged || subAccountChanged) {
      multiplySupplyVault.value = nextVault
      isMultiplySavingCollateral.value = nextIsSaving
      multiplySelectedSavingSubAccount.value = nextSubAccount
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
    account: planAccount,
  })
  const { cowSwapExecution, cowSwapOrderStatus, cowSwapStatusLabel, submitCowSwapMultiply } = cowSwap

  // --- Actions: submit & send ---
  const submitMultiply = async () => {
    if (isOperationBlocked.value) return
    if (isMultiplyPreparing.value || isGeoBlocked.value || isMultiplyRestricted.value) return
    if (multiplyErrorText.value) return

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
      if (isMultiplySubmitting.value || (!isConnected.value && !isSpyMode.value)) return
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

      profMark('review', 'submitMultiply.start')
      let subAccount: string
      try {
        subAccount = await profAsync('review', 'resolvePendingSubAccount', () => resolvePendingSubAccount())
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
        // Best case: the selected quote was lazily prepared in the background
        // when the user picked it, so we already have an envelope on the card.
        // Skip planMultiply + prepareTransactionPlan entirely.
        const matchingCard = quote && multiplySelectedQuoteCard.value?.quote === quote
          && quote.accountIn?.toLowerCase() === subAccount.toLowerCase()
          ? multiplySelectedQuoteCard.value
          : null
        if (planAccount.value) {
          try {
            await preloadSubAccountSnapshot(planAccount.value, subAccount as Address)
          }
          catch (e) {
            logWarn('multiply/review/preloadSubAccountSnapshot', e)
          }
        }
        if (matchingCard?.preparedPlan) {
          // Lazy-prepared envelope is available — short-circuit prepare entirely.
          multiplyPlan.value = matchingCard.plan ?? null
          preparedMultiplyPlan.value = matchingCard.preparedPlan as TransactionPlanPrepared
        }
        else {
          // Reuse the raw plan from the selected quote card when possible.
          const cachedPlan = matchingCard?.plan
          const account = planAccount.value
          multiplyPlan.value = cachedPlan ?? await profAsync('review', 'planMultiply', () => planMultiply({
            collateralVault: multiplySupplyVault.value!.address as Address,
            collateralAmount,
            collateralAsset: multiplySupplyVault.value!.asset.address as Address,
            collateralShareSource,
            longVault: multiplyLongVault.value!.address as Address,
            liabilityVault: multiplyShortVault.value!.address as Address,
            liabilityAmount: debtAmount,
            receiver: subAccount as Address,
            swapQuote: quote ?? undefined,
            swapperMode: SwapperMode.EXACT_IN,
            account,
            subAccountSnapshotApplied: Boolean(account),
          }))
          preparedMultiplyPlan.value = await profAsync('review', 'prepareTransactionPlan', () => prepareTransactionPlan(multiplyPlan.value!, { account }))
        }
      }
      catch (e) {
        logWarn('multiply/buildPlan', e)
        multiplyPlan.value = null
        preparedMultiplyPlan.value = null
      }

      if (preparedMultiplyPlan.value) {
        const ok = await profAsync('review', 'runPreparedSimulation', () => runMultiplySimulation(preparedMultiplyPlan.value!, buildMultiplyStateOverrideOptions()))
        if (!ok) return
      }

      profMark('review', 'submitMultiply.modalOpen')
      modal.open(OperationReviewModal, {
        props: {
          type: 'borrow',
          asset: multiplyShortVault.value.asset,
          amount: multiplyShortAmount.value || formatUnits(debtAmount, Number(multiplyShortVault.value.asset.decimals)),
          prepared: preparedMultiplyPlan.value || undefined,
          quoteFetchedAt: quote ? multiplyEffectiveQuoteFetchedAt.value : null,
          supplyingAssetForBorrow: multiplySupplyVault.value.asset,
          supplyingAmount: multiplyInputAmount.value,
          swapToAsset: quote ? multiplyLongVault.value.asset : undefined,
          swapToAmount: quote ? multiplyLongAmount.value : undefined,
          swapMode: quote ? SwapperMode.EXACT_IN : undefined,
          subAccount,
          submittingLabel: 'Submitting...',
          onConfirm: async () => {
            await sendMultiply()
          },
        },
      })
    }
    finally {
      isMultiplyPreparing.value = false
    }
  }

  const sendMultiply = async () => {
    // Use the unprepared plan and let executeTransactionPlan re-run plugins
    // at submit time — keeps the on-chain Pyth update payload fresh so the
    // staleness check can't bite us between Review-click and broadcast.
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
  // No-op kept for callers; multiplyAssetBalance is now a reactive computed.
  const updateMultiplyAssetBalance = async () => {}

  // --- Init ---
  const initMultiplySupplyVault = (vault: EVault) => {
    multiplySupplyVault.value = vault
    isMultiplySavingCollateral.value = false
    multiplySelectedSavingSubAccount.value = undefined
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

  watch(
    [multiplySupplyVault, multiplyLongVault, multiplyShortVault, isMultiplySavingCollateral, multiplySelectedSavingSubAccount],
    () => {
      clearMultiplySimulationError()
      resetMultiplyQuoteState()
      if (multiplyInputAmount.value) {
        requestMultiplyQuote()
      }
    },
  )

  // Pre-prime slot hints for the assets this form touches. Runs once per
  // asset (module-scope cache inside the SDK keeps subsequent prepares free).
  // Slots are owner-agnostic so a successful probe here keeps state-override
  // derivation hot through wallet/sub-account changes too.
  watch(
    [multiplySupplyVault, multiplyLongVault, multiplyShortVault],
    ([supply, long, short]) => {
      const tokens: Address[] = []
      const seen = new Set<string>()
      const push = (addr?: string) => {
        if (!addr) return
        const key = addr.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        tokens.push(addr as Address)
      }
      push(supply?.asset?.address)
      push(long?.asset?.address)
      push(short?.asset?.address)
      if (tokens.length) void primeSlotHintsFor(tokens)
    },
    { immediate: true },
  )

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
    multiplySelectedSavingSubAccount,
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
    multiplyEffectiveQuote,
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
    multiplyNetApyAfter,

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
    multiplyCapErrorText,
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
    buildMultiplyPlan, // Batch
    sendMultiply,
    updateMultiplyAssetBalance,
    initMultiplySupplyVault,
    resetOnTabSwitch,
  }
}
