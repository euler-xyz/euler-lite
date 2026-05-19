import type { Ref, ComputedRef } from 'vue'
import { formatUnits } from 'viem'
import { FixedPoint } from '~/utils/fixed-point'
import { logWarn } from '~/utils/errorHandling'
import { createRaceGuard } from '~/utils/race-guard'
import { getTotalCollateralValue } from '~/utils/position-estimates'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import { getNetAPY, getProjectedRates } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import type { AccountBorrowPosition } from '~/entities/account'
import type { TxPlan } from '~/entities/txPlan'
import { valueToNano } from '~/utils/crypto-utils'
import { trimTrailingZeros } from '~/utils/string-utils'
import { amountToPercent, percentToAmountNano } from '~/utils/repayUtils'
import { findBlockingDisabledOp, OP_REPAY, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import { getPlanHookDisabledWarning } from '~/composables/useVaultWarnings'
import type { Vault } from '~/entities/vault'

interface UseWalletRepayOptions {
  position: Ref<AccountBorrowPosition | undefined>
  borrowVault: ComputedRef<AccountBorrowPosition['borrow'] | undefined>
  collateralVault: ComputedRef<AccountBorrowPosition['collateral'] | undefined>
  formTab: Ref<string>
  walletBalance: Ref<bigint>
  plan: Ref<TxPlan | null>
  isSubmitting: Ref<boolean>
  isPreparing: Ref<boolean>
  clearSimulationError: () => void
  runSimulation: (plan: TxPlan) => Promise<boolean>
  netAPY: Ref<number>
  collateralSupplyApy: ComputedRef<number>
  borrowApy: ComputedRef<number>
  collateralSupplyRewardApy: ComputedRef<number>
  borrowRewardApy: ComputedRef<number>
  oraclePriceRatio: ComputedRef<number | null>
}

export const useWalletRepay = (options: UseWalletRepayOptions) => {
  const {
    position,
    borrowVault,
    collateralVault,
    formTab,
    walletBalance,
    plan,
    isSubmitting,
    isPreparing,
    clearSimulationError,
    runSimulation,
    netAPY,
    collateralSupplyApy,
    borrowApy,
    collateralSupplyRewardApy,
    borrowRewardApy,
    oraclePriceRatio,
  } = options

  const modal = useModal()
  const { error } = useToast()
  const { buildRepayPlan, buildFullRepayPlan, executeTxPlan } = useEulerOperations()
  const { isConnected } = useWagmi()
  const { finalizeTxAndRedirect } = useTxFinalization()

  const amount = ref('')
  const walletRepayPercent = ref(0)
  const hasEstimate = ref(false)
  const _estimateNetAPY = ref(0)
  const _estimateUserLTV = ref(0n)
  const _estimateHealth = ref(0n)
  const estimateNetAPY = computed(() => hasEstimate.value ? _estimateNetAPY.value : netAPY.value)
  const estimateUserLTV = computed(() => hasEstimate.value ? _estimateUserLTV.value : (position.value?.userLTV ?? 0n))
  const estimateHealth = computed(() => hasEstimate.value ? _estimateHealth.value : (position.value?.health ?? 0n))
  const estimatesError = ref('')
  const isEstimatesLoading = ref(false)

  const amountFixed = computed(() => FixedPoint.fromValue(
    valueToNano(amount.value || '0', borrowVault.value?.decimals),
    Number(borrowVault.value?.decimals),
  ))
  const borrowedFixed = computed(() => FixedPoint.fromValue(position.value?.borrowed || 0n, position.value?.borrow.decimals || 18))
  const suppliedFixed = computed(() => FixedPoint.fromValue(position.value?.supplied || 0n, position.value?.collateral.decimals || 18))
  const priceFixed = computed(() => {
    const ratio = oraclePriceRatio.value
    if (ratio && Number.isFinite(ratio) && ratio > 0) {
      return FixedPoint.fromValue(BigInt(Math.round(ratio * 1e18)), 18)
    }
    return FixedPoint.fromValue(0n, 18)
  })
  const { getVault: registryGetVault } = useVaultRegistry()

  // Wallet repay touches the liability vault (OP_REPAY). A full repay also
  // sweeps residual collateral shares back to the main account via
  // transferFromMax (OP_TRANSFER) on EVERY enabled collateral vault before
  // disabling the controller — check all of them, not just the primary.
  const walletRepayPlannedOps = computed<PlannedOp[]>(() => {
    const steps: PlannedOp[] = []
    if (borrowVault.value) steps.push({ vault: borrowVault.value, op: OP_REPAY })
    const amountNano = borrowVault.value
      ? valueToNano(amount.value || '0', borrowVault.value.asset.decimals)
      : 0n
    const currentDebt = position.value?.borrowed ?? 0n
    // Treat as full repay if the amount meets or exceeds the snapshot debt, or if
    // the user selected the max amount (100%). The latter catches the case where
    // accrued interest since the snapshot means amountNano < currentDebt at submit
    // time even though the user intends to repay in full.
    const isFullRepay = amountNano > 0n && (amountNano >= currentDebt || walletRepayPercent.value >= 100)
    if (isFullRepay) {
      const collAddrs = position.value?.collaterals ?? (collateralVault.value ? [collateralVault.value.address] : [])
      for (const addr of collAddrs) {
        const v = registryGetVault(addr) as Vault | undefined
        if (v) steps.push({ vault: v, op: OP_TRANSFER })
      }
    }
    return steps
  })

  const hookWarning = computed(() => getPlanHookDisabledWarning(walletRepayPlannedOps.value))

  const isSubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (findBlockingDisabledOp(walletRepayPlannedOps.value)) return true
    return !(+amount.value) || !!estimatesError.value || isEstimatesLoading.value
  })

  const submit = async () => {
    if (isPreparing.value || isSubmitting.value || !position.value || !borrowVault.value || !collateralVault.value) {
      return
    }

    isPreparing.value = true
    try {
      const amountNano = valueToNano(amount.value || '0', borrowVault.value.asset.decimals)
      const currentDebt = position.value.borrowed || 0n
      const shouldFullRepay = amountNano >= currentDebt || walletRepayPercent.value >= 100

      try {
        plan.value = shouldFullRepay
          ? await buildFullRepayPlan(
              borrowVault.value.address,
              borrowVault.value.asset.address,
              amountNano,
              position.value.subAccount,
              position.value.collaterals ?? [collateralVault.value.address],
              { includePermit2Call: false },
            )
          : await buildRepayPlan(
              borrowVault.value.address,
              borrowVault.value.asset.address,
              amountNano,
              position.value.subAccount,
              { includePermit2Call: false },
            )
      }
      catch (e) {
        logWarn('walletRepay/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value)
        if (!ok) return
      }

      modal.open(OperationReviewModal, {
        props: {
          type: 'repay',
          asset: position.value!.borrow.asset,
          amount: amount.value,
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
      if (!position.value || !borrowVault.value || !collateralVault.value) return

      const amountNano = valueToNano(amount.value, borrowVault.value.asset.decimals)
      const currentDebt = position.value.borrowed || 0n
      const isFullRepay = amountNano >= currentDebt || walletRepayPercent.value >= 100
      const txPlan = isFullRepay
        ? await buildFullRepayPlan(
            borrowVault.value.address,
            borrowVault.value.asset.address,
            amountNano,
            position.value.subAccount,
            position.value.collaterals ?? [collateralVault.value.address],
            { includePermit2Call: true },
          )
        : await buildRepayPlan(
            borrowVault.value.address,
            borrowVault.value.asset.address,
            amountNano,
            position.value.subAccount,
            { includePermit2Call: true },
          )
      await executeTxPlan(txPlan)
      await finalizeTxAndRedirect()
    }
    catch (e) {
      error('Transaction failed')
      logWarn('walletRepay/send', e)
    }
    finally {
      isSubmitting.value = false
    }
  }

  const updateSyncEstimates = () => {
    clearSimulationError()
    estimatesError.value = ''
    if (!position.value || !collateralVault.value || !borrowVault.value) return
    try {
      if (walletBalance.value < valueToNano(amount.value, borrowVault.value.decimals)) {
        throw new Error('Not enough balance')
      }
      if (borrowedFixed.value.lt(amountFixed.value)) {
        throw new Error('Repay amount exceeds outstanding debt')
      }
      // Use on-chain LTV to derive total collateral value (multi-collateral aware)
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
        : (borrowedFixed.value.sub(amountFixed.value))
            .div(collateralValue)
            .mul(FixedPoint.fromValue(100n, 0))
      const healthFixed = (userLtvFixed.isZero() || userLtvFixed.isNegative())
        ? null
        : FixedPoint.fromValue(position.value!.liquidationLTV, 2).div(userLtvFixed)
      _estimateUserLTV.value = userLtvFixed.toScaledBigint(18)
      _estimateHealth.value = healthFixed ? healthFixed.toScaledBigint(18) : 10n ** 36n
      hasEstimate.value = true
    }
    catch (e: unknown) {
      logWarn('walletRepay/syncEstimates', e)
      hasEstimate.value = false
      estimatesError.value = (e as { message: string }).message
    }
  }

  const asyncEstimatesGuard = createRaceGuard()
  const updateAsyncEstimates = useDebounceFn(async () => {
    if (!position.value || !collateralVault.value || !borrowVault.value) {
      isEstimatesLoading.value = false
      return
    }
    const gen = asyncEstimatesGuard.next()
    try {
      const repayNano = valueToNano(amount.value, borrowVault.value.decimals)
      const remainingBorrow = (position.value.borrowed || 0n) - repayNano

      const [projected, supplyUsd, borrowUsd] = await Promise.all([
        getProjectedRates(
          borrowVault.value.address,
          borrowVault.value.interestRateInfo.cash,
          borrowVault.value.interestRateInfo.borrows,
          repayNano,
          -repayNano,
        ),
        getAssetUsdValueOrZero(position.value.supplied || 0n, collateralVault.value, 'off-chain'),
        getAssetUsdValueOrZero(remainingBorrow > 0n ? remainingBorrow : 0n, borrowVault.value, 'off-chain'),
      ])

      if (asyncEstimatesGuard.isStale(gen)) return

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
    catch (e) {
      if (asyncEstimatesGuard.isStale(gen)) return
      logWarn('walletRepay/asyncEstimates', e)
    }
    finally {
      if (!asyncEstimatesGuard.isStale(gen)) {
        isEstimatesLoading.value = false
      }
    }
  }, 500)

  const onWalletRepayPercentInput = () => {
    clearSimulationError()
    if (!borrowVault.value || !position.value) {
      amount.value = ''
      walletRepayPercent.value = 0
      return
    }
    const currentDebt = position.value.borrowed || 0n
    if (currentDebt <= 0n) {
      amount.value = ''
      return
    }
    const amountNano = percentToAmountNano(walletRepayPercent.value, currentDebt)
    amount.value = trimTrailingZeros(formatUnits(amountNano, Number(borrowVault.value.asset.decimals)))
  }

  // Max on source input: clamp to current debt so clicking Max on wallet
  // balance > debt behaves like Max on debt (no over-repay). The watcher on
  // `amount` syncs walletRepayPercent and triggers estimates.
  const onSourceMax = () => {
    clearSimulationError()
    if (!borrowVault.value || !position.value) return
    const currentDebt = position.value.borrowed || 0n
    const cap = walletBalance.value < currentDebt ? walletBalance.value : currentDebt
    amount.value = trimTrailingZeros(formatUnits(cap, Number(borrowVault.value.asset.decimals)))
  }

  // Watch amount changes: sync percent slider + trigger estimates
  watch(amount, () => {
    clearSimulationError()
    if (formTab.value !== 'wallet') return

    if (position.value && borrowVault.value) {
      const currentDebt = position.value.borrowed || 0n
      if (currentDebt > 0n) {
        let amountNano = 0n
        try {
          amountNano = valueToNano(amount.value || '0', borrowVault.value.asset.decimals)
        }
        catch {
          amountNano = 0n
        }
        walletRepayPercent.value = amountToPercent(amountNano, currentDebt)
      }
      else {
        walletRepayPercent.value = 0
      }
    }
    if (!collateralVault.value) return
    updateSyncEstimates()
    if (!isEstimatesLoading.value) {
      isEstimatesLoading.value = true
    }
    updateAsyncEstimates()
  })

  const initEstimates = () => {
    hasEstimate.value = false
    estimatesError.value = ''
    isEstimatesLoading.value = false
  }

  const resetOnTabSwitch = () => {
    amount.value = ''
    walletRepayPercent.value = 0
    hasEstimate.value = false
    estimatesError.value = ''
    isEstimatesLoading.value = false
  }

  return {
    amount,
    walletRepayPercent,
    estimateNetAPY,
    estimateUserLTV,
    estimateHealth,
    estimatesError,
    isEstimatesLoading,
    isSubmitDisabled,
    hookWarning,
    amountFixed,
    borrowedFixed,
    suppliedFixed,
    priceFixed,
    submit,
    send,
    onWalletRepayPercentInput,
    onSourceMax,
    initEstimates,
    resetOnTabSwitch,
  }
}
