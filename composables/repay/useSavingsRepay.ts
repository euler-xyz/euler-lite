import type { EVault, SecuritizeCollateralVault, PortfolioBorrowPosition, SwapQuote, VaultEntity, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { isEVault, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'
import type { Ref, ComputedRef } from 'vue'
import { zeroAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import { getAssetUsdValue } from '~/utils/sdk-prices'
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
}

interface SavingsRepayPlanSnapshot {
  sourceVault?: EVault
  sourceSubAccount?: string
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
  } = options

  const modal = useModal()
  const { error } = useToast()
  const { isConnected, address } = useWagmi()
  const { planRepayFromSource, executePlan, prefetchPluginData } = useEulerTx()
  const { account: planAccount } = usePlanAccount()
  const { getVault: registryGetVault } = useVaultRegistry()
  const { finalizeTxAndRedirect } = useTxFinalization()

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
    sourceBalance,
    formTab,
    formTabName: 'savings',
    slippage,
    clearSimulationError,
    getCurrentDebt,
    buildTxPlanForQuote: (quote, _provider, context) => buildRepayPlan(quote, context.account),
    prefetchPluginData: (plan, account) => prefetchPluginData(plan, { account }),
    getPlanAccount: () => planAccount.value,
    getQuoteAccounts: () => {
      const savingsPos = sourceVault.value ? getSavingsPosition(sourceVault.value.address, selectedSavingSubAccount.value) : undefined
      const savingsSubAccount = (savingsPos?.subAccount || address.value || zeroAddress) as Address
      const borrowSubAccount = (position.value?.subAccount || address.value || zeroAddress) as Address
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

  // --- 4th USD watcher: primary collateral value (unchanged for savings) ---
  const savingsCollateralUsdGuard = createRaceGuard()
  const savingsCollateralUsd = ref<number | null>(null)

  watchEffect(async () => {
    if (!collateralVault.value || !position.value) {
      savingsCollateralUsd.value = null
      return
    }
    const gen = savingsCollateralUsdGuard.next()
    const result = (await getAssetUsdValue(position.value.supplied || 0n, collateralVault.value, 'off-chain')) ?? null
    if (savingsCollateralUsdGuard.isStale(gen)) return
    savingsCollateralUsd.value = result
  })

  // --- Health metrics ---
  const health = useRepayHealthMetrics({
    position,
    borrowVault,
    debtRepaid: core.debtRepaid,
    priceRatio: oraclePriceRatio,
    nextLiquidationLtv,
    collateralAmountAfter,
    collateralSupplyApy,
    borrowApy,
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
    if (!isConnected.value) return false
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
    if (!position.value || !borrowVault.value || !source) {
      throw new Error('Position or vaults not loaded')
    }

    const sourceSubAccount = snapshot.sourceSubAccount ?? selectedSavingSubAccount.value
    const savingsPos = getSavingsPosition(source.address, sourceSubAccount)
    if (!savingsPos) {
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
        ? valueToNano(debtAmountInput, borrowVault.value.asset.decimals)
        : valueToNano(amountInput, source.asset.decimals)
      const currentDebtVal = getCurrentDebt()
      isFullRepay = debtNano >= currentDebtVal
      liabilityAmount = isFullRepay ? maxUint256 : debtNano
    }
    else {
      swapQuote = quote ?? core.quotes.selectedQuote.value ?? undefined
      if (!swapQuote) {
        throw new Error('No quote selected')
      }
      swapMode = snapshot.direction ?? core.direction.value
      const currentDebt = getCurrentDebt()
      let targetDebt = 0n
      if (swapMode === SwapperMode.TARGET_DEBT && debtAmountInput) {
        const debtAmountNano = valueToNano(debtAmountInput, borrowVault.value.asset.decimals)
        targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
      }
      isFullRepay = targetDebt === 0n && swapMode === SwapperMode.TARGET_DEBT
    }

    return planRepayFromSource({
      liabilityVault: borrowVault.value.address as Address,
      liabilityAmount,
      receiver: position.value.subAccount as Address,
      fromVault: source.address as Address,
      fromAccount: savingsPos.subAccount as Address,
      swapQuote: sameAsset ? undefined : swapQuote,
      swapperMode: swapMode,
      cleanupOnMax: isFullRepay,
      account,
    })
  }

  const submit = async () => {
    if (isPreparing.value || isSubmitting.value || !position.value || !borrowVault.value || !sourceVault.value) return
    if (!core.isSameAsset.value && !core.quotes.selectedQuote.value) return

    isPreparing.value = true
    try {
      try {
        plan.value = await buildRepayPlan()
      }
      catch (e) {
        logWarn('savingsRepay/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value)
        if (!ok) return
      }

      const transferAmounts: Record<string, string> = {}
      if (collateralVault.value && position.value?.supplied) {
        const addr = collateralVault.value.address.toLowerCase()
        transferAmounts[addr] = nanoToValue(position.value.supplied, collateralVault.value.shares.decimals).toString()
      }

      const inputDisplay = getRepaySwapReviewInputAmount({
        amount: core.amount.value,
        quote: core.quotes.selectedQuote.value,
        sourceDecimals: sourceVault.value.asset.decimals,
        swapperMode: core.direction.value,
      })

      modal.open(OperationReviewModal, {
        props: {
          type: 'repay',
          asset: sourceVault.value.asset,
          amount: inputDisplay,
          quoteFetchedAt: !core.isSameAsset.value ? core.quotes.effectiveQuoteFetchedAt.value : null,
          swapToAsset: !core.isSameAsset.value ? borrowVault.value.asset : undefined,
          swapToAmount: !core.isSameAsset.value ? core.debtAmount.value : undefined,
          swapMode: !core.isSameAsset.value ? core.direction.value : undefined,
          plan: plan.value || undefined,
          subAccount: position.value?.subAccount,
          hasBorrows: (position.value?.borrowed || 0n) > 0n,
          transferAmounts,
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
    if (!position.value || !borrowVault.value || !sourceVault.value) return
    if (!core.isSameAsset.value && !core.quotes.selectedQuote.value) return
    try {
      isSubmitting.value = true
      const txPlan = await buildRepayPlan()
      await executePlan(txPlan)
      await finalizeTxAndRedirect()
    }
    catch (e) {
      error('Transaction failed')
      logWarn('savingsRepay/send', e)
    }
    finally {
      isSubmitting.value = false
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
    send,
    updateSourceBalance,
    initVault,
    resetOnTabSwitch,
    // Batch
    buildRepayPlan,
  }
}
