import type { Ref, ComputedRef } from 'vue'
import { useAccount } from '@wagmi/vue'
import { zeroAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import { getCashLimitedWithdrawAmount, isEVKVault, type Vault, type SecuritizeVault } from '~/entities/vault'
import { getAssetUsdValue } from '~/services/pricing/priceProvider'
import type { AccountBorrowPosition } from '~/entities/account'
import type { TxPlan } from '~/entities/txPlan'
import { SwapperMode } from '~/entities/swap'
import { useRepaySavingsOptions } from '~/composables/useRepaySavingsOptions'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { useRepaySwapCore } from '~/composables/repay/useRepaySwapCore'
import { useRepaySwapDetails } from '~/composables/repay/useRepaySwapDetails'
import { useRepayHealthMetrics } from '~/composables/repay/useRepayHealthMetrics'
import { getRepaySwapReviewInputAmount } from '~/composables/repay/reviewAmount'
import { adjustForInterest } from '~/composables/useEulerOperations/helpers'
import { getSwapInputAmount } from '~/composables/useEulerOperations/swaps/verify'
import { nanoToValue, valueToNano } from '~/utils/crypto-utils'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { createRaceGuard } from '~/utils/race-guard'
import { findBlockingDisabledOp, OP_REPAY_WITH_SHARES, OP_SKIM, OP_TRANSFER, OP_WITHDRAW, type PlannedOp } from '~/utils/vault-hooks'
import { getPlanHookDisabledWarning, getUtilisationWarning, type VaultWarning } from '~/composables/useVaultWarnings'

interface UseSavingsRepayOptions {
  position: Ref<AccountBorrowPosition | undefined>
  borrowVault: ComputedRef<AccountBorrowPosition['borrow'] | undefined>
  collateralVault: ComputedRef<AccountBorrowPosition['collateral'] | undefined>
  formTab: Ref<string>
  plan: Ref<TxPlan | null>
  isSubmitting: Ref<boolean>
  isPreparing: Ref<boolean>
  slippage: Readonly<Ref<number>>
  oraclePriceRatio: ComputedRef<number | null>
  clearSimulationError: () => void
  runSimulation: (plan: TxPlan) => Promise<boolean>
  getCurrentDebt: () => bigint
  collateralSupplyApy: ComputedRef<number>
  borrowApy: ComputedRef<number>
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
  const { isConnected, address } = useAccount()
  const { buildSwapPlan, buildSavingsRepayPlan, buildSavingsFullRepayPlan, buildSwapFullRepayPlan, executeTxPlan } = useEulerOperations()
  const { getVault: registryGetVault } = useVaultRegistry()
  const { finalizeTxAndRedirect } = useTxFinalization()

  // --- Savings options ---
  const { savingsPositions, savingsVaults, savingsOptions, getSavingsPosition } = useRepaySavingsOptions()

  // --- Source vault state ---
  const sourceVault: Ref<Vault | undefined> = ref()
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
    getQuoteAccounts: () => {
      const savingsPos = sourceVault.value ? getSavingsPosition(sourceVault.value.address) : undefined
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
    return nanoToValue(position.value.supplied || 0n, collateralVault.value.decimals)
  })

  const nextLiquidationLtv = computed(() => {
    if (!position.value) return null
    return nanoToValue(position.value.liquidationLTV, 2)
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
    if (sourceVault.value && !isSameVaultRepay.value) steps.push({ vault: sourceVault.value as Vault, op: OP_WITHDRAW })
    if (borrowVault.value) {
      if (!isSameVaultRepay.value) {
        steps.push({ vault: borrowVault.value as Vault, op: OP_SKIM })
      }
      steps.push({ vault: borrowVault.value as Vault, op: OP_REPAY_WITH_SHARES })
    }
    if (isEffectivelyFullRepay.value) {
      // Full repay sweeps all enabled collaterals via transferFromMax.
      const collateralAddresses = position.value?.collaterals ?? []
      for (const addr of collateralAddresses) {
        const vault = registryGetVault(addr) as Vault | SecuritizeVault | undefined
        if (vault && isEVKVault(vault)) {
          steps.push({ vault, op: OP_TRANSFER })
        }
      }
      if (sourceVault.value) steps.push({ vault: sourceVault.value as Vault, op: OP_TRANSFER })
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
    !isSameVaultRepay.value && requiredInput.value > 0n && requiredInput.value > (sourceVault.value?.totalCash || 0n),
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
    const pos = getSavingsPosition(sourceVault.value.address)
    sourceAssets.value = pos?.assets || 0n
  }

  watch(sourceVault, () => {
    updateSourceBalance()
  })

  // --- Build / Submit / Send ---
  const buildRepayPlan = async (): Promise<TxPlan> => {
    if (!position.value || !borrowVault.value || !sourceVault.value) {
      throw new Error('Position or vaults not loaded')
    }

    const savingsPos = getSavingsPosition(sourceVault.value.address)
    if (!savingsPos) {
      throw new Error('Savings position not found')
    }

    if (core.isSameAsset.value) {
      const debtNano = core.debtAmount.value
        ? valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals)
        : valueToNano(core.amount.value, sourceVault.value.asset.decimals)
      const currentDebtVal = getCurrentDebt()
      const isFullRepay = debtNano >= currentDebtVal

      if (isFullRepay) {
        return buildSavingsFullRepayPlan({
          savingsVaultAddress: sourceVault.value.address,
          borrowVaultAddress: borrowVault.value.address,
          amount: currentDebtVal,
          savingsSubAccount: savingsPos.subAccount,
          borrowSubAccount: position.value.subAccount,
          enabledCollaterals: position.value.collaterals,
        })
      }
      return buildSavingsRepayPlan({
        savingsVaultAddress: sourceVault.value.address,
        borrowVaultAddress: borrowVault.value.address,
        amount: debtNano,
        savingsSubAccount: savingsPos.subAccount,
        borrowSubAccount: position.value.subAccount,
      })
    }

    if (!core.quotes.selectedQuote.value) {
      throw new Error('No quote selected')
    }

    const currentDebt = getCurrentDebt()
    const swapMode = core.direction.value
    let targetDebt = 0n
    if (swapMode === SwapperMode.TARGET_DEBT && core.debtAmount.value) {
      const debtAmountNano = valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals)
      targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
    }

    const isFullRepay = targetDebt === 0n && swapMode === SwapperMode.TARGET_DEBT
    if (isFullRepay) {
      return buildSwapFullRepayPlan({
        quote: core.quotes.selectedQuote.value,
        swapperMode: swapMode,
        requestedSlippage: slippage.value,
        targetDebt,
        currentDebt,
        liabilityVault: borrowVault.value.address,
        enabledCollaterals: position.value.collaterals,
        source: 'savings',
      })
    }

    return buildSwapPlan({
      quote: core.quotes.selectedQuote.value,
      swapperMode: swapMode,
      isRepay: true,
      requestedSlippage: slippage.value,
      targetDebt,
      currentDebt,
      liabilityVault: borrowVault.value.address,
      enabledCollaterals: position.value.collaterals,
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
        transferAmounts[addr] = nanoToValue(position.value.supplied, collateralVault.value.decimals).toString()
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
      await executeTxPlan(txPlan)
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
    if (savingsVaults.value.length > 0) {
      sourceVault.value = savingsVaults.value[0] as Vault
      updateSourceBalance()
    }
  }

  const resetOnTabSwitch = () => {
    core.resetCore()
    core.debtPercent.value = 0
  }

  const onSourceVaultChange = (selectedIndex: number) => {
    core.onSourceVaultChange(selectedIndex, savingsVaults)
  }

  return {
    // State
    sourceVault,
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
    // Handlers
    onAmountInput: core.onAmountInput,
    onDebtInput: core.onDebtInput,
    onPercentInput: core.onPercentInput,
    onSourceVaultChange,
    onRefreshQuotes: core.onRefreshQuotes,
    onSourceMax: core.onSourceMax,
    onProviderSelect: core.onProviderSelect,
    submit,
    send,
    updateSourceBalance,
    initVault,
    resetOnTabSwitch,
  }
}
