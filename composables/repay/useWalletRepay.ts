import { getPositionMultiplier } from '~/utils/vault/apy'
import { isEVault, type SecuritizeCollateralVault, type EVault, type PortfolioBorrowPosition, type VaultEntity, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { Ref, ComputedRef } from 'vue'
import { maxUint256, type Address } from 'viem'
import { useToast } from '~/components/ui/composables/useToast'
import { getAssetUsdValueForEstimate } from '~/utils/sdk-prices'
import { formatUnits } from 'viem'
import { FixedPoint } from '~/utils/fixed-point'
import { logWarn } from '~/utils/errorHandling'
import { createRaceGuard } from '~/utils/race-guard'
import { getTotalCollateralValue } from '~/utils/position-estimates'
import { valueToNano, nanoToValue } from '~/utils/crypto-utils'
import { trimTrailingZeros } from '~/utils/string-utils'
import { amountToPercent, percentToAmountNano } from '~/utils/repayUtils'
import { findBlockingDisabledOp, OP_REPAY, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import { getPlanHookDisabledWarning } from '~/composables/useVaultWarnings'
import { getBorrowPositionEffectiveLiquidationLTV, decimalLtvToBps } from '~/utils/ltv'
import { getVaultBorrowApy } from '~/utils/vault-display'
import { withProjectedVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import {
  getCollateralSnapshotCampaignInputs,
  getCollateralSnapshotRateLines,
  getProjectedYieldStateFromCollateralSnapshot,
  mergeProjectedRewardCampaigns,
  type ProjectedYieldCampaignInput,
  type ProjectedYieldDetails,
} from '~/utils/projected-yield'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'

interface UseWalletRepayOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  collateralVault: ComputedRef<EVault | SecuritizeCollateralVault | undefined>
  formTab: Ref<string>
  walletBalance: Ref<bigint>
  plan: Ref<TransactionPlan | null>
  isSubmitting: Ref<boolean>
  isPreparing: Ref<boolean>
  clearSimulationError: () => void
  runSimulation: (plan: TransactionPlan) => Promise<boolean>
  netAPY: Ref<number | null>
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
    borrowApy,
    oraclePriceRatio,
  } = options

  const { error } = useToast()
  const { planRepayFromWallet } = useEulerTx()
  const { open: openReviewState } = useExecutionReview()
  const { create: createIntent } = useOperationIntentFactory()
  const { account: planAccount } = usePlanAccount()
  const { primeSlotHintsFor } = useStateOverrideOptions()
  const { isConnected } = useWagmi()
  const { isSpyMode } = useSpyMode()
  const { finalizeExecutionUi } = useTxFinalization()
  const { getCollateralApySnapshot } = usePositionCollateralApy()
  const {
    version: rewardsVersion,
    getBorrowRewardApyForCollaterals,
    getEligibleLoopingRewardApyForCollaterals,
    getBorrowRewardCampaignsForCollaterals,
    getEligibleLoopingRewardCampaignsForCollaterals,
  } = useRewardsApy()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)

  const amount = ref('')
  const walletRepayPercent = ref(0)
  const hasEstimate = ref(false)
  const _estimateNetAPY = ref<number | null>(null)
  const projectedYieldDetails = ref<ProjectedYieldDetails | null>(null)
  const _estimateUserLTV = ref(0n)
  const _estimateHealth = ref(0n)
  const estimateNetAPY = computed(() => hasEstimate.value ? _estimateNetAPY.value : netAPY.value)
  const estimateUserLTV = computed(() => hasEstimate.value ? _estimateUserLTV.value : (position.value ? (position.value.userLTV ?? 0n) * 100n : 0n))
  const estimateHealth = computed(() => hasEstimate.value ? _estimateHealth.value : (position.value ? position.value.healthFactor ?? 0n : 0n))
  const estimatesError = ref('')
  const isEstimatesLoading = ref(false)

  const amountFixed = computed(() => FixedPoint.fromValue(
    valueToNano(amount.value || '0', borrowVault.value?.asset.decimals),
    Number(borrowVault.value?.asset.decimals),
  ))
  const borrowedFixed = computed(() => FixedPoint.fromValue(position.value?.borrowed || 0n, borrowVault.value?.shares.decimals || 18))
  const suppliedFixed = computed(() => FixedPoint.fromValue(position.value?.supplied || 0n, collateralVault.value?.shares.decimals || 18))
  const priceFixed = computed(() => {
    const ratio = oraclePriceRatio.value
    if (ratio && Number.isFinite(ratio) && ratio > 0) {
      return FixedPoint.fromValue(BigInt(Math.round(ratio * 1e18)), 18)
    }
    return FixedPoint.fromValue(0n, 18)
  })
  const { getVault: registryGetVault } = useVaultRegistry()

  // Pre-prime the repaid asset's ERC20 slot hints so later estimate/sim calls skip
  // access-list discovery. Speculative, so it must not gate the submit button
  // (`background: true`) — see `useStateOverrideResolution`.
  watch(
    () => borrowVault.value?.asset.address,
    (assetAddress) => {
      if (assetAddress) void primeSlotHintsFor([assetAddress as Address], { background: true })
    },
    { immediate: true },
  )

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
      const collAddrs = position.value
        ? position.value.collateralVaults
        : (collateralVault.value ? [collateralVault.value.address] : [])
      for (const addr of collAddrs) {
        const v = registryGetVault(addr)
        // Only EVK collaterals get swept via transferFromMax; securitize
        // vaults don't implement it and the SDK's appendMaxRepayCleanup
        // skips them. Mirror that here so the OP_TRANSFER warning surface
        // doesn't claim a transfer that won't happen.
        if (v && isEVault(v)) steps.push({ vault: v, op: OP_TRANSFER })
      }
    }
    return steps
  })

  const hookWarning = computed(() => getPlanHookDisabledWarning(walletRepayPlannedOps.value))

  const isSubmitDisabled = computed(() => {
    if (!isConnected.value && !isSpyMode.value) return true
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
      const args = {
        liabilityVault: borrowVault.value.address as Address,
        liabilityAsset: borrowVault.value.asset.address as Address,
        liabilityAmount: shouldFullRepay ? maxUint256 : amountNano,
        receiver: position.value.subAccount as Address,
        cleanupOnMax: shouldFullRepay,
      }
      const intent = createIntent({
        kind: 'repay',
        planner: 'repay-from-wallet',
        args,
        source: 'position/repay-wallet:review',
        subAccounts: [args.receiver],
      })

      try {
        plan.value = await planRepayFromWallet({ ...args, account: planAccount.value })
      }
      catch (e) {
        logWarn('walletRepay/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value)
        if (!ok) return
      }

      if (!plan.value) return
      await openReviewState([intent], {
        presentationKind: 'repay',
        review: {
          type: 'repay',
          asset: borrowVault.value.asset,
          amount: amount.value,
          subAccount: position.value?.subAccount,
          hasBorrows: (position.value?.borrowed || 0n) > 0n,
          submittingLabel: 'Submitting...',
        },
        onSucceeded: () => finalizeExecutionUi(),
        onFailed: (cause) => {
          error('Transaction failed')
          logWarn('walletRepay/send', cause)
        },
      })
    }
    finally {
      isPreparing.value = false
    }
  }

  const updateSyncEstimates = (): boolean => {
    clearSimulationError()
    estimatesError.value = ''
    hasEstimate.value = false
    if (!position.value || !collateralVault.value || !borrowVault.value || !(+amount.value > 0)) return false
    try {
      if (walletBalance.value < valueToNano(amount.value, borrowVault.value.shares.decimals)) {
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
      const effectiveLiquidationLtv = getBorrowPositionEffectiveLiquidationLTV(position.value!)
      if (effectiveLiquidationLtv === undefined) throw new Error('Liquidation LTV unavailable')
      const liquidationLtv = decimalLtvToBps(effectiveLiquidationLtv)
      const healthFixed = (userLtvFixed.isZero() || userLtvFixed.isNegative())
        ? null
        : FixedPoint.fromValue(liquidationLtv, 2).div(userLtvFixed)
      _estimateUserLTV.value = userLtvFixed.toScaledBigint(18)
      _estimateHealth.value = healthFixed ? healthFixed.toScaledBigint(18) : 10n ** 36n
      hasEstimate.value = true

      if (userLtvFixed.gte(FixedPoint.fromValue(liquidationLtv, 2))) {
        throw new Error('Not enough liquidity for the vault, LTV is too large')
      }
      return true
    }
    catch (e: unknown) {
      logWarn('walletRepay/syncEstimates', e)
      hasEstimate.value = false
      estimatesError.value = (e as { message: string }).message
      return false
    }
  }

  const asyncEstimatesGuard = createRaceGuard()
  const updateAsyncEstimates = useDebounceFn(async (gen: number) => {
    if (asyncEstimatesGuard.isStale(gen)) return
    const currentPosition = position.value
    const currentCollateralVault = collateralVault.value
    const currentBorrowVault = borrowVault.value
    const currentBorrowApy = borrowApy.value
    _estimateNetAPY.value = null
    projectedYieldDetails.value = null
    if (!currentPosition || !currentCollateralVault || !currentBorrowVault) {
      isEstimatesLoading.value = false
      return
    }
    try {
      const repayNano = valueToNano(amount.value, currentBorrowVault.shares.decimals)
      const remainingBorrow = (currentPosition.borrowed || 0n) - repayNano

      const [currentCollateralSnapshot, nextCollateralSnapshot, currentBorrowUsd, borrowUsd] = await Promise.all([
        getCollateralApySnapshot(currentPosition, currentBorrowVault),
        getCollateralApySnapshot(currentPosition, currentBorrowVault, {
          liabilityRateDelta: {
            cashDelta: repayNano,
            borrowsDelta: -repayNano,
          },
        }),
        getAssetUsdValueForEstimate(currentPosition.borrowed || 0n, currentBorrowVault, 'off-chain'),
        getAssetUsdValueForEstimate(remainingBorrow > 0n ? remainingBorrow : 0n, currentBorrowVault, 'off-chain'),
      ])

      if (asyncEstimatesGuard.isStale(gen)) return
      const projected = nextCollateralSnapshot.liabilityProjectedRates
      if (
        !projected
        || !currentCollateralSnapshot.isComplete
        || !nextCollateralSnapshot.isComplete
        || currentBorrowUsd === undefined
        || borrowUsd === undefined
      ) {
        _estimateNetAPY.value = null
        projectedYieldDetails.value = null
        return
      }

      const currentRaw = getVaultBorrowApy(currentBorrowVault)
      const projectedBorrowApy = withProjectedVaultIntrinsicApy(
        currentRaw,
        nanoToValue(projected.borrowAPY, 25),
        currentBorrowVault,
        enableIntrinsicApy.value,
      )
      const loopingRewardApy = getEligibleLoopingRewardApyForCollaterals(
        currentBorrowVault.address,
        nextCollateralSnapshot.collateralAddresses,
        getPositionMultiplier(nextCollateralSnapshot.supplyUsd, borrowUsd),
      )
      const projectedRaw = nanoToValue(projected.borrowAPY, 25)
      const currentMultiplier = getPositionMultiplier(currentCollateralSnapshot.supplyUsd, currentBorrowUsd)
      const nextMultiplier = getPositionMultiplier(nextCollateralSnapshot.supplyUsd, borrowUsd)
      const currentCollateralAddresses = currentCollateralSnapshot.collateralAddresses
      const nextCollateralAddresses = nextCollateralSnapshot.collateralAddresses
      const currentBorrowRewardApy = getBorrowRewardApyForCollaterals(
        currentBorrowVault.address,
        currentCollateralAddresses,
      )
      const nextBorrowRewardApy = getBorrowRewardApyForCollaterals(
        currentBorrowVault.address,
        nextCollateralAddresses,
      )
      const currentLoopingRewardApy = getEligibleLoopingRewardApyForCollaterals(
        currentBorrowVault.address,
        currentCollateralAddresses,
        currentMultiplier,
      )
      const before = getProjectedYieldStateFromCollateralSnapshot('net-apy', currentCollateralSnapshot, {
        borrowUsd: currentBorrowUsd,
        baseBorrowApy: currentRaw,
        borrowApyWithIntrinsic: currentBorrowApy,
        borrowRewardApy: currentBorrowRewardApy,
        loopingRewardApy: currentLoopingRewardApy,
      })
      const after = getProjectedYieldStateFromCollateralSnapshot('net-apy', nextCollateralSnapshot, {
        borrowUsd,
        baseBorrowApy: projectedRaw,
        borrowApyWithIntrinsic: projectedBorrowApy,
        borrowRewardApy: nextBorrowRewardApy,
        loopingRewardApy,
      })
      if (!after) {
        _estimateNetAPY.value = null
        projectedYieldDetails.value = null
        return
      }

      const getCampaignInputs = (
        snapshot: CollateralApySnapshot,
        multiplier: number | null,
        hasDebt: boolean,
      ): ProjectedYieldCampaignInput[] => [
        ...getCollateralSnapshotCampaignInputs(snapshot),
        ...(hasDebt
          ? getBorrowRewardCampaignsForCollaterals(currentBorrowVault.address, snapshot.collateralAddresses)
              .map(campaign => ({ campaign, vaultAddress: currentBorrowVault.address }))
          : []),
        ...getEligibleLoopingRewardCampaignsForCollaterals(
          currentBorrowVault.address,
          snapshot.collateralAddresses,
          multiplier,
        ).map(campaign => ({ campaign, vaultAddress: currentBorrowVault.address })),
      ]

      _estimateNetAPY.value = after.total
      projectedYieldDetails.value = {
        metric: 'net-apy',
        before,
        after,
        rateLines: [
          ...getCollateralSnapshotRateLines(currentCollateralSnapshot, nextCollateralSnapshot),
          {
            id: `borrow:${currentBorrowVault.address.toLowerCase()}`,
            label: 'Borrow APY',
            symbol: currentBorrowVault.asset.symbol,
            vaultAddress: currentBorrowVault.address,
            before: currentRaw,
            after: projectedRaw,
          },
        ],
        rewards: mergeProjectedRewardCampaigns(
          getCampaignInputs(currentCollateralSnapshot, currentMultiplier, currentBorrowUsd > 0),
          getCampaignInputs(nextCollateralSnapshot, nextMultiplier, borrowUsd > 0),
        ),
      }
    }
    catch (e) {
      if (asyncEstimatesGuard.isStale(gen)) return
      logWarn('walletRepay/asyncEstimates', e)
      _estimateNetAPY.value = null
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
    _estimateNetAPY.value = null
    projectedYieldDetails.value = null
    if (formTab.value !== 'wallet' || !updateSyncEstimates()) {
      isEstimatesLoading.value = false
      return
    }
    isEstimatesLoading.value = true
    updateAsyncEstimates(gen)
  }

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
    asyncEstimatesGuard.next()
    _estimateNetAPY.value = null
    projectedYieldDetails.value = null
    clearSimulationError()
    if (formTab.value !== 'wallet') return

    if (position.value && borrowVault.value) {
      const currentDebt = position.value.borrowed || 0n
      if (currentDebt > 0n) {
        let amountNano: bigint
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
    if (!collateralVault.value) {
      hasEstimate.value = false
      isEstimatesLoading.value = false
      return
    }
    queueAsyncEstimates()
  })

  watch([rewardsVersion, enableIntrinsicApy], () => {
    if (!(+amount.value > 0)) return
    queueAsyncEstimates()
  })

  watch([
    position,
    borrowVault,
    collateralVault,
    borrowApy,
    () => position.value?.borrowed,
    () => position.value?.collateralVaults?.join(','),
  ], () => {
    asyncEstimatesGuard.next()
    hasEstimate.value = false
    _estimateNetAPY.value = null
    projectedYieldDetails.value = null
    if (!(+amount.value > 0)) {
      isEstimatesLoading.value = false
      return
    }
    queueAsyncEstimates()
  })

  const initEstimates = () => {
    asyncEstimatesGuard.next()
    hasEstimate.value = false
    _estimateNetAPY.value = null
    projectedYieldDetails.value = null
    estimatesError.value = ''
    isEstimatesLoading.value = false
  }

  const resetOnTabSwitch = () => {
    asyncEstimatesGuard.next()
    amount.value = ''
    walletRepayPercent.value = 0
    hasEstimate.value = false
    _estimateNetAPY.value = null
    projectedYieldDetails.value = null
    estimatesError.value = ''
    isEstimatesLoading.value = false
  }

  return {
    amount,
    walletRepayPercent,
    estimateNetAPY,
    projectedYieldDetails,
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
    onWalletRepayPercentInput,
    onSourceMax,
    initEstimates,
    resetOnTabSwitch,
  }
}
