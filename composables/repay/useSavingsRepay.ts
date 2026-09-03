import type { EVault, SecuritizeCollateralVault, PortfolioBorrowPosition, SwapQuote, VaultEntity, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { isEVault, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'
import type { Ref, ComputedRef } from 'vue'
import { zeroAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { useToast } from '~/components/ui/composables/useToast'
import { getBorrowPositionEffectiveLiquidationLTV } from '~/utils/ltv'
import { maxUint256 } from 'viem'
import { useRepaySavingsOptions } from '~/composables/useRepaySavingsOptions'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { useRepaySwapCore } from '~/composables/repay/useRepaySwapCore'
import { useRepaySwapDetails } from '~/composables/repay/useRepaySwapDetails'
import { useRepayHealthMetrics } from '~/composables/repay/useRepayHealthMetrics'
import { getRepaySwapReviewInputAmount } from '~/composables/repay/reviewAmount'
import { adjustForInterest } from '~/utils/adjust-for-interest'
import { getSwapInputAmount } from '~/utils/swapQuotes'
import { nanoToValue, valueToNano } from '~/utils/crypto-utils'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { createRaceGuard } from '~/utils/race-guard'
import { findBlockingDisabledOp, OP_REPAY_WITH_SHARES, OP_SKIM, OP_TRANSFER, OP_WITHDRAW, type PlannedOp } from '~/utils/vault-hooks'
import { getPlanHookDisabledWarning, getUtilisationWarning, type VaultWarning } from '~/composables/useVaultWarnings'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'
import { selectMatchingPreparedIntents } from '~/features/reviewed-execution/planning/requirements'

interface UseSavingsRepayOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  collateralVault: ComputedRef<EVault | SecuritizeCollateralVault | undefined>
  formTab: Ref<string>
  plan: Ref<TransactionPlan | null>
  isSubmitting: Ref<boolean>
  isPreparing: Ref<boolean>
  slippage: Readonly<Ref<number>>
  oraclePriceRatio: ComputedRef<number | null>
  clearSimulationError: () => void
  runSimulation: (plan: TransactionPlan) => Promise<boolean>
  getCurrentDebt: () => bigint
  collateralSupplyApy: ComputedRef<number>
  borrowApy: ComputedRef<number>
  borrowRewardApy: ComputedRef<number>
}

interface SavingsRepayPlanSnapshot {
  sourceVault?: EVault
  sourceSubAccount?: string
  sourceAccount?: Address
  targetAccount?: Address
  borrowVault?: EVault
  currentDebt?: bigint
  amount?: string
  debtAmount?: string
  direction?: SwapperMode
  isSameAsset?: boolean
}

export const useSavingsRepay = (options: UseSavingsRepayOptions) => {
  const {
    position,
    borrowVault,
    collateralVault,
    formTab,
    plan,
    isSubmitting,
    isPreparing,
    slippage,
    oraclePriceRatio,
    clearSimulationError,
    runSimulation,
    getCurrentDebt,
    collateralSupplyApy,
    borrowApy,
    borrowRewardApy,
  } = options

  const { error } = useToast()
  const { isConnected, isSpyMode, effectiveAddress } = useEffectiveAddress()
  const { planRepayFromSource, prefetchPluginData } = useEulerTx()
  const { create: createIntent } = useOperationIntentFactory()
  const { open: openReviewState } = useExecutionReview()
  const { account: planAccount } = usePlanAccount()
  const { getVault: registryGetVault } = useVaultRegistry()
  const { finalizeExecutionUi } = useTxFinalization()
  const { getCollateralApySnapshot } = usePositionCollateralApy()

  // --- Savings options ---
  const { savingsPositions, savingsVaults, savingsOptions, getSavingsPosition } = useRepaySavingsOptions()

  // --- Source vault state ---
  const sourceVault: Ref<EVault | undefined> = ref()
  // Picks the savings position when the user has the same vault on multiple
  // sub-accounts; without this `getSavingsPosition` falls back to the silent-
  // first-match behaviour PR #436 fixed.
  const selectedSavingSubAccount = ref<string | undefined>(undefined)
  const sourceAssets = ref(0n)
  const isSameVaultRepay = computed(() =>
    !!sourceVault.value
    && !!borrowVault.value
    && normalizeAddressOrEmpty(sourceVault.value.address) === normalizeAddressOrEmpty(borrowVault.value.address),
  )
  // Same-vault repay never withdraws (uses repayWithShares directly), so cash
  // capacity is irrelevant — only sourceAssets bounds the operation.
  const sourceBalance = computed(() => getCashLimitedWithdrawAmount(
    sourceAssets.value,
    isSameVaultRepay.value ? undefined : sourceVault.value,
  ))
  const debtBalance = computed(() => position.value?.borrowed || 0n)

  const priceInvert = usePriceInvert(
    () => sourceVault.value?.asset.symbol,
    () => borrowVault.value?.asset.symbol,
  )
  priceInvert.autoInvert(oraclePriceRatio)
  const sourceProduct = useEulerProductOfVault(computed(() => sourceVault.value?.address || ''))

  // --- Core swap logic ---
  const core = useRepaySwapCore({
    position,
    borrowVault,
    sourceVault,
    sourceAssets,
    sourceBalance,
    formTab,
    formTabName: 'savings',
    slippage,
    clearSimulationError,
    getCurrentDebt,
    buildTxPlanForQuote: (quote, _provider, context) => buildRepayPlan(quote, context.account),
    createIntentsForQuote: quote => [createRepayIntent(quote)],
    prefetchPluginData: (plan, account, intents) => prefetchPluginData(plan, { account, intents }),
    getPlanAccount: () => planAccount.value,
    getQuoteAccounts: () => {
      const savingsPos = sourceVault.value ? getSavingsPosition(sourceVault.value.address, selectedSavingSubAccount.value) : undefined
      const savingsSubAccount = (savingsPos?.subAccount || effectiveAddress.value || zeroAddress) as Address
      const borrowSubAccount = (position.value?.subAccount || effectiveAddress.value || zeroAddress) as Address
      return { accountIn: savingsSubAccount, accountOut: borrowSubAccount }
    },
  })

  // --- Swap details ---
  const details = useRepaySwapDetails({
    quotes: core.quotes,
    sourceVault,
    borrowVault,
    direction: core.direction,
  })
  // --- Savings-specific computeds ---
  const collateralAmountAfter = computed(() => {
    if (!collateralVault.value || !position.value) return null
    return nanoToValue(position.value.supplied || 0n, collateralVault.value.shares.decimals)
  })

  const nextLiquidationLtv = computed(() => {
    if (!position.value) return null
    const liquidationLTV = getBorrowPositionEffectiveLiquidationLTV(position.value)
    return liquidationLTV === undefined ? null : ltvToPercent(liquidationLTV)
  })

  // --- Collateral portfolio value/APY (unchanged for savings repay) ---
  const savingsCollateralUsdGuard = createRaceGuard()
  const savingsCollateralUsd = ref<number | null>(null)
  const savingsWeightedCollateralApy = ref<number | null>(null)
  const savingsCollateralAddresses = ref<string[]>([])
  const savingsCollateralSnapshotComplete = ref(false)
  const savingsCollateralSnapshot = shallowRef<CollateralApySnapshot | null>(null)
  const nextSavingsWeightedCollateralApy = ref<number | null>(null)
  const nextSavingsCollateralAddresses = ref<string[]>([])
  const nextSavingsCollateralSnapshotComplete = ref(false)
  const nextSavingsCollateralSnapshot = shallowRef<CollateralApySnapshot | null>(null)

  watchEffect(async () => {
    const gen = savingsCollateralUsdGuard.next()
    const currentBorrowVault = borrowVault.value
    const currentPosition = position.value
    const currentSourceVault = sourceVault.value
    const spent = core.spent.value
    const debtRepaid = core.debtRepaid.value
    const sourceAddress = normalizeAddressOrEmpty(currentSourceVault?.address)
    const sourceIsPositionCollateral = !!sourceAddress && (currentPosition?.collateralVaults ?? [])
      .some(address => normalizeAddressOrEmpty(address) === sourceAddress)
    const withdrawalCashDelta = currentSourceVault
      && !isSameVaultRepay.value
      && sourceIsPositionCollateral
      && spent !== null
      && spent > 0n
      ? -spent
      : null

    if (!currentBorrowVault || !currentPosition) {
      savingsCollateralUsd.value = null
      savingsWeightedCollateralApy.value = null
      savingsCollateralAddresses.value = []
      savingsCollateralSnapshotComplete.value = false
      savingsCollateralSnapshot.value = null
      nextSavingsWeightedCollateralApy.value = null
      nextSavingsCollateralAddresses.value = []
      nextSavingsCollateralSnapshotComplete.value = false
      nextSavingsCollateralSnapshot.value = null
      return
    }
    savingsCollateralSnapshotComplete.value = false
    savingsCollateralSnapshot.value = null
    nextSavingsCollateralSnapshotComplete.value = false
    nextSavingsCollateralSnapshot.value = null
    const snapshotPromise = getCollateralApySnapshot(currentPosition, currentBorrowVault)
    const repayAmount = debtRepaid === null
      ? null
      : debtRepaid > (currentPosition.borrowed || 0n)
        ? currentPosition.borrowed || 0n
        : debtRepaid
    const nextSnapshotPromise = withdrawalCashDelta !== null || repayAmount !== null
      ? getCollateralApySnapshot(currentPosition, currentBorrowVault, {
          deltas: withdrawalCashDelta !== null
            ? [{
                vaultAddress: sourceAddress,
                assetsDelta: 0n,
                cashDelta: withdrawalCashDelta,
                projectRates: true,
              }]
            : [],
          ...(repayAmount !== null
            ? {
                liabilityRateDelta: {
                  cashDelta: isSameVaultRepay.value ? 0n : repayAmount,
                  borrowsDelta: -repayAmount,
                },
              }
            : {}),
        })
      : snapshotPromise
    const [snapshot, nextSnapshot] = await Promise.all([snapshotPromise, nextSnapshotPromise])
    if (savingsCollateralUsdGuard.isStale(gen)) return
    savingsCollateralUsd.value = snapshot.supplyUsd
    savingsWeightedCollateralApy.value = snapshot.weightedSupplyApy
    savingsCollateralAddresses.value = snapshot.collateralAddresses ?? currentPosition.collateralVaults ?? []
    savingsCollateralSnapshotComplete.value = snapshot.isComplete
    savingsCollateralSnapshot.value = snapshot.isComplete ? snapshot : null
    nextSavingsWeightedCollateralApy.value = nextSnapshot.weightedSupplyApy
    nextSavingsCollateralAddresses.value = nextSnapshot.collateralAddresses ?? currentPosition.collateralVaults ?? []
    nextSavingsCollateralSnapshotComplete.value = nextSnapshot.isComplete
    nextSavingsCollateralSnapshot.value = nextSnapshot.isComplete ? nextSnapshot : null
  })
  const effectiveCollateralSupplyApy = computed(() => savingsWeightedCollateralApy.value ?? collateralSupplyApy.value)
  const nextEffectiveCollateralSupplyApy = computed(() =>
    nextSavingsWeightedCollateralApy.value ?? effectiveCollateralSupplyApy.value,
  )

  // --- Health metrics ---
  const health = useRepayHealthMetrics({
    position,
    borrowVault,
    debtRepaid: core.debtRepaid,
    priceRatio: oraclePriceRatio,
    nextLiquidationLtv,
    collateralAmountAfter,
    collateralSupplyApy: effectiveCollateralSupplyApy,
    nextCollateralSupplyApy: nextEffectiveCollateralSupplyApy,
    borrowApy,
    borrowRewardApy,
    collateralSnapshotComplete: savingsCollateralSnapshotComplete,
    nextCollateralSnapshotComplete: nextSavingsCollateralSnapshotComplete,
    collateralAddresses: savingsCollateralAddresses,
    nextCollateralAddresses: nextSavingsCollateralAddresses,
    collateralSnapshot: savingsCollateralSnapshot,
    nextCollateralSnapshot: nextSavingsCollateralSnapshot,
    projectedBorrowRates: computed(() => nextSavingsCollateralSnapshot.value?.liabilityProjectedRates ?? null),
    repayAddsCash: computed(() => !isSameVaultRepay.value),
    collateralValueUsd: savingsCollateralUsd,
    nextCollateralValueUsd: savingsCollateralUsd,
    borrowValueUsd: core.borrowValueUsd,
    nextBorrowValueUsd: core.nextBorrowValueUsd,
  })

  // Savings repay: savings.WITHDRAW + liability.SKIM + liability.REPAY_WITH_SHARES.
  // Full repay additionally sweeps collateral + savings shares back via
  // transferFromMax (OP_TRANSFER on collateral and savings vaults).
  // Heuristic: for cross-asset paths, core.debtRepaid uses the quote's
  // amountOut (pre-slippage). At the exact debt boundary, the on-chain
  // execution may land on either side. Over-estimating triggers the
  // OP_TRANSFER check for a partial repay (harmless — the warning is
  // accurate since a full close would also need OP_TRANSFER). Under-
  // estimating omits the check for a true full repay — extremely narrow.
  const isEffectivelyFullRepay = computed(() => {
    if (!position.value || (position.value.borrowed ?? 0n) <= 0n) return false
    const repaid = core.debtRepaid.value
    return repaid !== null && repaid >= (position.value.borrowed ?? 0n)
  })

  const savingsRepayPlannedOps = computed<PlannedOp[]>(() => {
    const steps: PlannedOp[] = []
    if (sourceVault.value && !isSameVaultRepay.value) steps.push({ vault: sourceVault.value as EVault, op: OP_WITHDRAW })
    if (borrowVault.value) {
      if (!isSameVaultRepay.value) {
        steps.push({ vault: borrowVault.value as EVault, op: OP_SKIM })
      }
      steps.push({ vault: borrowVault.value as EVault, op: OP_REPAY_WITH_SHARES })
    }
    if (isEffectivelyFullRepay.value) {
      // Full repay sweeps all enabled collaterals via transferFromMax.
      const collateralAddresses = position.value ? position.value.collateralVaults : []
      for (const addr of collateralAddresses) {
        const vault = registryGetVault(addr) as EVault | SecuritizeCollateralVault | undefined
        if (vault && isEVault(vault)) {
          steps.push({ vault, op: OP_TRANSFER })
        }
      }
      if (sourceVault.value) steps.push({ vault: sourceVault.value as EVault, op: OP_TRANSFER })
    }
    return steps
  })

  const hookWarning = computed(() => getPlanHookDisabledWarning(savingsRepayPlannedOps.value))

  // Uses amountInMax (slippage-padded) when available so the user sees an
  // insufficient-balance error before hitting an on-chain revert.
  const requiredInput = computed(() => {
    if (core.isSameAsset.value) {
      const spent = core.spent.value ?? 0n
      return isEffectivelyFullRepay.value
        ? adjustForInterest(spent)
        : spent
    }
    const q = core.quotes.selectedQuote.value
    if (!q) return 0n
    return getSwapInputAmount(q, core.direction.value)
  })
  const isInsufficientSource = computed(() => requiredInput.value > 0n && requiredInput.value > sourceAssets.value)
  const isInsufficientVaultLiquidity = computed(() =>
    !isSameVaultRepay.value && requiredInput.value > 0n && requiredInput.value > (sourceVault.value?.availableLiquidity ?? 0n),
  )
  const liquidityWarning = computed<VaultWarning | null>(() => {
    if (!sourceVault.value) return null
    return getUtilisationWarning(sourceVault.value, 'repay')
  })

  // --- Submit disabled ---
  const isSubmitDisabled = computed(() => {
    if (!isConnected.value && !isSpyMode.value) return false
    if (findBlockingDisabledOp(savingsRepayPlannedOps.value)) return true
    if (!sourceVault.value || !borrowVault.value) return true
    if (!core.debtAmount.value && !core.amount.value) return true
    if (core.isRepayExceedsDebt.value) return true
    if (isInsufficientSource.value) return true
    if (isInsufficientVaultLiquidity.value) return true
    if (core.isSameAsset.value) return false
    if (core.quotes.quoteError.value) return true
    if (!core.quotes.selectedQuote.value) return true
    return false
  })

  const disabledReason = computed(() => {
    if (core.isRepayExceedsDebt.value) {
      return 'You repaying more than required'
    }
    if (isInsufficientSource.value) {
      return 'Insufficient savings balance to cover the required swap amount.'
    }
    if (isInsufficientVaultLiquidity.value) {
      return 'Not enough liquidity in the savings vault.'
    }
    return undefined
  })

  // --- Balance ---
  const updateSourceBalance = () => {
    if (!sourceVault.value) {
      sourceAssets.value = 0n
      return
    }
    const pos = getSavingsPosition(sourceVault.value.address, selectedSavingSubAccount.value)
    sourceAssets.value = pos?.assets || 0n
  }

  watch([sourceVault, selectedSavingSubAccount], () => {
    updateSourceBalance()
  })

  // Whether the current inputs repay the whole debt. Mirrors the full-repay
  // branch in buildRepayPlan, where the plan opts into cleanup (remaining
  // collateral shares are moved to the owner account).
  const isFullRepay = computed(() => {
    if (!position.value || !borrowVault.value || !sourceVault.value) return false
    const currentDebt = getCurrentDebt()
    if (currentDebt <= 0n) return false
    if (core.isSameAsset.value) {
      const debtNano = core.debtAmount.value
        ? valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals)
        : valueToNano(core.amount.value, sourceVault.value.asset.decimals)
      return debtNano >= currentDebt
    }
    if (core.direction.value !== SwapperMode.TARGET_DEBT) return false
    if (!core.debtAmount.value) return true
    return valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals) >= currentDebt
  })

  // --- Build / Submit / Send ---
  const buildRepayPlan = async (
    quote?: SwapQuote,
    account = planAccount.value,
    snapshot: SavingsRepayPlanSnapshot = {},
  ): Promise<TransactionPlan> => {
    const source = snapshot.sourceVault ?? sourceVault.value
    const liability = snapshot.borrowVault ?? borrowVault.value
    const receiver = snapshot.targetAccount ?? position.value?.subAccount as Address | undefined
    if (!receiver || !liability || !source) {
      throw new Error('Position or vaults not loaded')
    }

    const sourceSubAccount = snapshot.sourceSubAccount ?? selectedSavingSubAccount.value
    const sourceAccount = snapshot.sourceAccount
      ?? getSavingsPosition(source.address, sourceSubAccount)?.subAccount as Address | undefined
    if (!sourceAccount) {
      throw new Error('Savings position not found')
    }
    const sameAsset = snapshot.isSameAsset ?? core.isSameAsset.value
    const amountInput = snapshot.amount ?? core.amount.value
    const debtAmountInput = snapshot.debtAmount ?? core.debtAmount.value

    let isFullRepay: boolean
    let liabilityAmount = 0n
    let swapMode: SwapperMode | undefined
    let swapQuote: SwapQuote | undefined

    if (sameAsset) {
      const debtNano = debtAmountInput
        ? valueToNano(debtAmountInput, liability.asset.decimals)
        : valueToNano(amountInput, source.asset.decimals)
      const currentDebtVal = snapshot.currentDebt ?? getCurrentDebt()
      isFullRepay = debtNano >= currentDebtVal
      liabilityAmount = isFullRepay ? maxUint256 : debtNano
    }
    else {
      swapQuote = quote ?? core.quotes.selectedQuote.value ?? undefined
      if (!swapQuote) {
        throw new Error('No quote selected')
      }
      swapMode = snapshot.direction ?? core.direction.value
      const currentDebt = snapshot.currentDebt ?? getCurrentDebt()
      let targetDebt = 0n
      if (swapMode === SwapperMode.TARGET_DEBT && debtAmountInput) {
        const debtAmountNano = valueToNano(debtAmountInput, liability.asset.decimals)
        targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
      }
      isFullRepay = targetDebt === 0n && swapMode === SwapperMode.TARGET_DEBT
    }

    return planRepayFromSource({
      liabilityVault: liability.address as Address,
      liabilityAsset: liability.asset.address as Address,
      liabilityAmount,
      receiver,
      fromVault: source.address as Address,
      fromAccount: sourceAccount,
      swapQuote: sameAsset ? undefined : swapQuote,
      swapperMode: swapMode,
      cleanupOnMax: isFullRepay,
      account,
    })
  }

  const createRepayIntent = (
    quote?: SwapQuote,
    snapshot: SavingsRepayPlanSnapshot = {},
  ) => {
    const source = snapshot.sourceVault ?? sourceVault.value
    const liability = snapshot.borrowVault ?? borrowVault.value
    const receiver = snapshot.targetAccount ?? position.value?.subAccount as Address | undefined
    if (!receiver || !liability || !source) throw new Error('Position or vaults not loaded')
    const sourceSubAccount = snapshot.sourceSubAccount ?? selectedSavingSubAccount.value
    const fromAccount = snapshot.sourceAccount
      ?? getSavingsPosition(source.address, sourceSubAccount)?.subAccount as Address | undefined
    if (!fromAccount) throw new Error('Savings position not found')
    const sameAsset = snapshot.isSameAsset ?? core.isSameAsset.value
    const amountInput = snapshot.amount ?? core.amount.value
    const debtAmountInput = snapshot.debtAmount ?? core.debtAmount.value
    if (sameAsset) {
      const debtNano = debtAmountInput
        ? valueToNano(debtAmountInput, liability.asset.decimals)
        : valueToNano(amountInput, source.asset.decimals)
      const isFullRepay = debtNano >= (snapshot.currentDebt ?? getCurrentDebt())
      return createIntent({
        kind: 'repay',
        planner: 'repay-from-deposit',
        args: {
          liabilityVault: liability.address as Address,
          liabilityAsset: liability.asset.address as Address,
          liabilityAmount: isFullRepay ? maxUint256 : debtNano,
          receiver,
          fromVault: source.address as Address,
          fromAccount,
          cleanupOnMax: isFullRepay,
        },
        source: 'position/repay-savings',
        subAccounts: [receiver, fromAccount],
      })
    }
    const swapQuote = quote ?? core.quotes.selectedQuote.value ?? undefined
    if (!swapQuote) throw new Error('No quote selected')
    const swapperMode = snapshot.direction ?? core.direction.value
    const currentDebt = snapshot.currentDebt ?? getCurrentDebt()
    let targetDebt = 0n
    if (swapperMode === SwapperMode.TARGET_DEBT && debtAmountInput) {
      const debtAmountNano = valueToNano(debtAmountInput, liability.asset.decimals)
      targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
    }
    const cleanupOnMax = targetDebt === 0n && swapperMode === SwapperMode.TARGET_DEBT
    return createIntent({
      kind: 'repay',
      planner: 'repay-with-swap',
      args: { swapQuote, cleanupOnMax, swapperMode },
      source: 'position/repay-savings',
      subAccounts: [receiver, fromAccount],
    })
  }

  const submit = async () => {
    if (isPreparing.value || isSubmitting.value || !position.value || !borrowVault.value || !sourceVault.value) return
    if (!core.isSameAsset.value && !core.quotes.selectedQuote.value) return

    isPreparing.value = true
    try {
      const targetAccount = position.value.subAccount as Address
      const selectedSavings = getSavingsPosition(sourceVault.value.address, selectedSavingSubAccount.value)
      if (!selectedSavings) return
      const quote = core.isSameAsset.value ? undefined : core.quotes.selectedQuote.value ?? undefined
      const snapshot: SavingsRepayPlanSnapshot = Object.freeze({
        sourceVault: sourceVault.value,
        sourceSubAccount: selectedSavingSubAccount.value,
        sourceAccount: selectedSavings.subAccount as Address,
        targetAccount,
        borrowVault: borrowVault.value,
        currentDebt: getCurrentDebt(),
        amount: core.amount.value,
        debtAmount: core.debtAmount.value,
        direction: core.direction.value,
        isSameAsset: core.isSameAsset.value,
      })
      const quoteFetchedAt = core.quotes.effectiveQuoteFetchedAt.value
      const positionSupplied = position.value.supplied
      const collateralSnapshot = collateralVault.value
      const planAccountSnapshot = planAccount.value
      const quoteIntents = quote && core.quotes.selectedQuoteCard.value?.quote === quote
        ? core.quotes.selectedQuoteCard.value.intents
        : undefined
      const currentIntents = [createRepayIntent(quote, snapshot)]
      const intents = selectMatchingPreparedIntents(quoteIntents, currentIntents)
      const transferAmounts: Record<string, string> = {}
      if (collateralSnapshot && positionSupplied) {
        const addr = collateralSnapshot.address.toLowerCase()
        transferAmounts[addr] = nanoToValue(positionSupplied, collateralSnapshot.shares.decimals).toString()
      }
      const inputDisplay = getRepaySwapReviewInputAmount({
        amount: snapshot.amount!,
        quote,
        sourceDecimals: snapshot.sourceVault!.asset.decimals,
        swapperMode: snapshot.direction!,
      })
      try {
        plan.value = await buildRepayPlan(quote, planAccountSnapshot, snapshot)
      }
      catch (e) {
        logWarn('savingsRepay/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value)
        if (!ok) return
      }

      if (!plan.value) return
      await openReviewState(intents, {
        presentationKind: 'repay',
        review: {
          type: 'repay',
          asset: snapshot.sourceVault!.asset,
          amount: inputDisplay,
          quoteFetchedAt: !snapshot.isSameAsset ? quoteFetchedAt : null,
          swapToAsset: !snapshot.isSameAsset ? snapshot.borrowVault!.asset : undefined,
          swapToAmount: !snapshot.isSameAsset ? snapshot.debtAmount : undefined,
          swapMode: !snapshot.isSameAsset ? snapshot.direction : undefined,
          subAccount: snapshot.targetAccount,
          sourceSubAccount: snapshot.sourceAccount,
          hasBorrows: snapshot.currentDebt! > 0n,
          transferAmounts,
          submittingLabel: 'Submitting...',
        },
        onSucceeded: () => finalizeExecutionUi(),
        onFailed: (cause) => {
          error('Transaction failed')
          logWarn('savingsRepay/send', cause)
        },
      })
    }
    finally {
      isPreparing.value = false
    }
  }

  const initVault = () => {
    if (savingsPositions.value.length > 0) {
      const first = savingsPositions.value[0]
      sourceVault.value = first.vault as EVault
      selectedSavingSubAccount.value = first.subAccount as string
      updateSourceBalance()
    }
  }

  const resetOnTabSwitch = () => {
    core.resetCore()
    core.debtPercent.value = 0
  }

  const onSourceVaultChange = (selectedIndex: number) => {
    core.onSourceVaultChange(selectedIndex, savingsVaults)
    // Capture the sub-account from the picked option so the form stops
    // silently routing through the first matching savings position.
    const opt = savingsOptions.value[selectedIndex]
    selectedSavingSubAccount.value = opt?.subAccount
  }

  return {
    // State
    sourceVault,
    selectedSavingSubAccount,
    amount: core.amount,
    debtAmount: core.debtAmount,
    direction: core.direction,
    debtPercent: core.debtPercent,
    sourceAssets,
    sourceBalance,
    debtBalance,
    priceInvert,
    sourceProduct,
    savingsPositions,
    savingsVaults,
    savingsOptions,
    quotes: core.quotes,
    isSameAsset: core.isSameAsset,
    spent: core.spent,
    debtRepaid: core.debtRepaid,
    // Health metrics
    roeBefore: health.roeBefore,
    roeAfter: health.roeAfter,
    projectedYieldDetails: health.projectedYieldDetails,
    currentHealth: health.currentHealth,
    currentLtv: health.currentLtv,
    nextLtv: health.nextLtv,
    nextHealth: health.nextHealth,
    currentLiquidationPrice: health.currentLiquidationPrice,
    nextLiquidationPrice: health.nextLiquidationPrice,
    // Swap details
    currentPrice: details.currentPrice,
    summary: details.summary,
    priceImpact: details.priceImpact,
    leveragedPriceImpact: details.leveragedPriceImpact,
    routedVia: details.routedVia,
    routeEmptyMessage: details.routeEmptyMessage,
    routeItems: details.routeItems,
    // Submit
    isSubmitDisabled,
    disabledReason,
    hookWarning,
    liquidityWarning,
    isRepayExceedsDebt: core.isRepayExceedsDebt,
    isFullRepay,
    // Handlers
    onAmountInput: core.onAmountInput,
    onDebtInput: core.onDebtInput,
    onPercentInput: core.onPercentInput,
    onSourceVaultChange,
    onRefreshQuotes: core.onRefreshQuotes,
    onSourceMax: core.onSourceMax,
    submit,
    updateSourceBalance,
    initVault,
    resetOnTabSwitch,
    // Batch
    buildRepayPlan,
    createRepayIntent,
  }
}
