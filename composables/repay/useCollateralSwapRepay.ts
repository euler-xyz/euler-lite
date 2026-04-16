import type { Ref, ComputedRef } from 'vue'
import { useAccount } from '@wagmi/vue'
import { zeroAddress, type Address, type Abi } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep } from '~/utils/stepDecoding'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import { isEVKVault, type Vault } from '~/entities/vault'
import { COWSWAP_PROVIDER_NAME, COWSWAP_ORDER_DEADLINE_SECONDS, type CowSwapClosePositionExecuteParams, getCowSwapChainConfig } from '~/entities/cowswap'
import { useCowSwapClosePositionExecution, useCowSwapOrderStatus, openCowSwapReviewModal } from '~/composables/cowswap'
import { getAssetUsdValue, getAssetOraclePrice, conservativePriceRatioNumber } from '~/services/pricing/priceProvider'
import type { AccountBorrowPosition } from '~/entities/account'
import type { TxPlan } from '~/entities/txPlan'
import { SwapperMode } from '~/entities/swap'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { useRepaySwapCore } from '~/composables/repay/useRepaySwapCore'
import { useRepaySwapDetails } from '~/composables/repay/useRepaySwapDetails'
import { useRepayHealthMetrics } from '~/composables/repay/useRepayHealthMetrics'
import { nanoToValue, valueToNano } from '~/utils/crypto-utils'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { createRaceGuard } from '~/utils/race-guard'
import { findBlockingDisabledOp, OP_REPAY, OP_REPAY_WITH_SHARES, OP_SKIM, OP_TRANSFER, OP_WITHDRAW, type PlannedOp } from '~/utils/vault-hooks'
import { getPlanHookDisabledWarning } from '~/composables/useVaultWarnings'

interface UseCollateralSwapRepayOptions {
  position: Ref<AccountBorrowPosition | undefined>
  borrowVault: ComputedRef<AccountBorrowPosition['borrow'] | undefined>
  collateralVault: ComputedRef<AccountBorrowPosition['collateral'] | undefined>
  formTab: Ref<string>
  plan: Ref<TxPlan | null>
  isSubmitting: Ref<boolean>
  isPreparing: Ref<boolean>
  slippage: Readonly<Ref<number>>
  clearSimulationError: () => void
  runSimulation: (plan: TxPlan) => Promise<boolean>
  getCurrentDebt: () => bigint
  isEligibleForLiquidation: ComputedRef<boolean>
}

export const useCollateralSwapRepay = (options: UseCollateralSwapRepayOptions) => {
  const {
    position,
    borrowVault,
    collateralVault,
    formTab,
    plan,
    isSubmitting,
    isPreparing,
    slippage,
    clearSimulationError,
    runSimulation,
    getCurrentDebt,
    isEligibleForLiquidation,
  } = options

  const router = useRouter()
  const modal = useModal()
  const { error } = useToast()
  const { isConnected, address } = useAccount()
  const { buildSwapPlan, buildSameAssetRepayPlan, buildSameAssetFullRepayPlan, buildSwapFullRepayPlan, executeTxPlan } = useEulerOperations()
  const { refreshAllPositions } = useEulerAccount()
  const { eulerLensAddresses, isReady: isEulerAddressesReady, loadEulerConfig } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()
  const { withIntrinsicSupplyApy, withIntrinsicBorrowApy } = useIntrinsicApy()
  const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()

  // --- Source vault state ---
  const sourceVault: Ref<Vault | undefined> = ref()
  const sourceAssets = ref(0n)
  const sourceBalance = computed(() => sourceAssets.value)
  const debtBalance = computed(() => position.value?.borrowed || 0n)

  const priceInvert = usePriceInvert(
    () => sourceVault.value?.asset.symbol,
    () => borrowVault.value?.asset.symbol,
  )
  const sourceProduct = useEulerProductOfVault(computed(() => sourceVault.value?.address || ''))

  // --- Collateral options ---
  const { collateralOptions: swapCollateralOptions, collateralVaults: swapCollateralVaults } = useSwapCollateralOptions({
    currentVault: computed(() => undefined),
    liabilityVault: computed(() => borrowVault.value as typeof borrowVault.value),
    tagContext: 'supply-source',
  })

  const repayCollateralVaults = computed(() => {
    if (!position.value) return []
    const allowed = position.value.collaterals?.length
      ? new Set(position.value.collaterals.map(addr => normalizeAddressOrEmpty(addr)))
      : null
    const candidates = swapCollateralVaults.value
    const filtered = allowed
      ? candidates.filter(vault => allowed.has(normalizeAddressOrEmpty(vault.address)))
      : candidates
    if (!filtered.length && collateralVault.value) {
      return [collateralVault.value]
    }
    return filtered
  })

  const repayCollateralOptions = computed(() => {
    const allowed = new Set(repayCollateralVaults.value.map(vault => normalizeAddressOrEmpty(vault.address)))
    return swapCollateralOptions.value.filter(option => allowed.has(normalizeAddressOrEmpty(option.vaultAddress)))
  })

  // --- Core swap logic ---
  const core = useRepaySwapCore({
    position,
    borrowVault,
    sourceVault,
    sourceBalance,
    formTab,
    formTabName: 'collateral',
    slippage,
    clearSimulationError,
    getCurrentDebt,
    includeCowSwap: true,
    getQuoteAccounts: () => {
      const subAccount = (position.value?.subAccount || address.value || zeroAddress) as Address
      return { accountIn: subAccount, accountOut: subAccount }
    },
  })

  // --- CowSwap close position ---
  const { chainId: currentChainId } = useEulerAddresses()
  const cowModal = useModal()
  const cowSwapExecution = useCowSwapClosePositionExecution()
  const cowSwapOrderbookUrl = computed(() => getCowSwapChainConfig(currentChainId.value ?? 0)?.orderbookUrl)
  const cowSwapOrderStatus = useCowSwapOrderStatus(
    computed(() => cowSwapExecution.orderUid.value),
    cowSwapOrderbookUrl,
  )
  const isCowSwapProvider = computed(() =>
    core.quotes.selectedProvider.value?.toLowerCase() === COWSWAP_PROVIDER_NAME,
  )

  // --- Swap details ---
  const details = useRepaySwapDetails({
    quotes: core.quotes,
    sourceVault,
    borrowVault,
    direction: core.direction,
  })

  // --- APYs ---
  const collateralSupplyApy = computed(() => {
    if (!sourceVault.value) return null
    const base = nanoToValue(sourceVault.value.interestRateInfo.supplyAPY || 0n, 25)
    return withIntrinsicSupplyApy(base, sourceVault.value.asset.address) + getSupplyRewardApy(sourceVault.value.address)
  })

  const borrowApy = computed(() => {
    if (!borrowVault.value) return null
    const base = nanoToValue(borrowVault.value.interestRateInfo.borrowAPY || 0n, 25)
    return withIntrinsicBorrowApy(base, borrowVault.value.asset.address) - getBorrowRewardApy(borrowVault.value.address, collateralVault.value?.address)
  })

  // --- Price ratio ---
  const priceRatio = computed(() => {
    if (!sourceVault.value || !borrowVault.value) return null
    const collateralPrice = getAssetOraclePrice(sourceVault.value)
    const borrowPrice = getAssetOraclePrice(borrowVault.value)
    return conservativePriceRatioNumber(collateralPrice, borrowPrice)
  })
  priceInvert.autoInvert(priceRatio)

  // --- Collateral-specific computeds ---
  const collateralAmountAfter = computed(() => {
    if (!sourceVault.value || core.spent.value === null) return null
    const nextAssets = sourceAssets.value - core.spent.value
    return nanoToValue(nextAssets > 0n ? nextAssets : 0n, sourceVault.value.decimals)
  })

  const nextLiquidationLtv = computed(() => {
    if (!borrowVault.value || !sourceVault.value) return null
    const match = borrowVault.value.collateralLTVs.find(
      ltv => normalizeAddressOrEmpty(ltv.collateral) === normalizeAddressOrEmpty(sourceVault.value?.address),
    )
    if (match) return nanoToValue(match.liquidationLTV, 2)
    if (!position.value) return null
    return nanoToValue(position.value.liquidationLTV, 2)
  })

  // --- 4th USD watcher: next collateral value ---
  const nextCollateralUsdGuard = createRaceGuard()
  const nextCollateralValueUsd = ref<number | null>(null)

  watchEffect(async () => {
    if (!sourceVault.value || core.spent.value === null) {
      nextCollateralValueUsd.value = null
      return
    }
    const gen = nextCollateralUsdGuard.next()
    const nextAssets = sourceAssets.value - core.spent.value
    const result = (await getAssetUsdValue(nextAssets > 0n ? nextAssets : 0n, sourceVault.value, 'off-chain')) ?? null
    if (nextCollateralUsdGuard.isStale(gen)) return
    nextCollateralValueUsd.value = result
  })

  // --- Health metrics ---
  const health = useRepayHealthMetrics({
    position,
    borrowVault,
    debtRepaid: core.debtRepaid,
    priceRatio,
    nextLiquidationLtv,
    collateralAmountAfter,
    collateralSupplyApy,
    borrowApy,
    collateralValueUsd: core.sourceValueUsd,
    nextCollateralValueUsd,
    borrowValueUsd: core.borrowValueUsd,
    nextBorrowValueUsd: core.nextBorrowValueUsd,
  })

  // --- Health gate ---
  const isHealthInsufficient = computed(() => {
    if (!isEligibleForLiquidation.value) return false
    if (health.nextHealth.value === null) return false
    return health.nextHealth.value < 1
  })

  // Collateral-swap repay. Same-asset path: source.WITHDRAW + liability.SKIM
  // + liability.REPAY_WITH_SHARES. Cross-asset path: source.WITHDRAW + swap +
  // liability.REPAY (done by swapper). Full repay: + collateral.TRANSFER.
  // Heuristic: for cross-asset paths, core.debtRepaid uses the quote's
  // amountOut (pre-slippage). See useSavingsRepay for the precision note.
  const isEffectivelyFullRepay = computed(() => {
    if (!position.value || (position.value.borrowed ?? 0n) <= 0n) return false
    const repaid = core.debtRepaid.value
    return repaid !== null && repaid >= (position.value.borrowed ?? 0n)
  })

  const collateralSwapRepayPlannedOps = computed<PlannedOp[]>(() => {
    const steps: PlannedOp[] = []
    if (sourceVault.value) steps.push({ vault: sourceVault.value as Vault, op: OP_WITHDRAW })
    if (borrowVault.value) {
      if (core.isSameAsset.value) {
        // Same-asset: withdraw → skim → repayWithShares
        steps.push({ vault: borrowVault.value as Vault, op: OP_SKIM })
        steps.push({ vault: borrowVault.value as Vault, op: OP_REPAY_WITH_SHARES })
      }
      else {
        // Cross-asset: swapper internally calls repay
        steps.push({ vault: borrowVault.value as Vault, op: OP_REPAY })
      }
    }
    if (isEffectivelyFullRepay.value) {
      for (const vault of repayCollateralVaults.value) {
        if (isEVKVault(vault)) {
          steps.push({ vault, op: OP_TRANSFER })
        }
      }
    }
    return steps
  })

  const hookWarning = computed(() => getPlanHookDisabledWarning(collateralSwapRepayPlannedOps.value))

  // --- Submit disabled ---
  const isSubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (findBlockingDisabledOp(collateralSwapRepayPlannedOps.value)) return true
    if (!sourceVault.value || !borrowVault.value) return true
    if (!core.debtAmount.value && !core.amount.value) return true
    if (core.isSameAsset.value) {
      if (isHealthInsufficient.value) return true
      return false
    }
    if (core.isRepayExceedsDebt.value) return true
    if (core.quotes.quoteError.value) return true
    if (!core.quotes.selectedQuote.value) return true
    if (isHealthInsufficient.value) return true
    return false
  })

  const disabledReason = computed(() => {
    if (core.isRepayExceedsDebt.value) {
      return 'You repaying more than required'
    }
    if (isHealthInsufficient.value) {
      return 'This swap will not restore account health. Repay the full debt from your wallet instead.'
    }
    return undefined
  })

  // --- Balance ---
  const updateSourceBalance = async () => {
    if (!position.value || !sourceVault.value) {
      sourceAssets.value = 0n
      return
    }
    const primaryAddress = normalizeAddressOrEmpty(position.value.collateral.address)
    const targetAddress = normalizeAddressOrEmpty(sourceVault.value.address)
    sourceAssets.value = targetAddress === primaryAddress ? (position.value.supplied || 0n) : 0n

    try {
      if (!isEulerAddressesReady.value) {
        await loadEulerConfig()
      }
      const lensAddress = eulerLensAddresses.value?.accountLens
      if (!lensAddress) {
        throw new Error('Account lens address is not available')
      }
      const res = await rpcClient.value!.readContract({
        address: lensAddress as Address,
        abi: eulerAccountLensABI as Abi,
        functionName: 'getVaultAccountInfo',
        args: [position.value.subAccount, sourceVault.value.address],
      }) as { assets: bigint }
      sourceAssets.value = res.assets
    }
    catch (e) {
      logWarn('collateralSwapRepay/loadBalance', e)
    }
  }

  watch([sourceVault, position], () => {
    void updateSourceBalance()
  }, { immediate: true })

  // --- Build / Submit / Send ---
  const buildRepayPlan = async (): Promise<TxPlan> => {
    if (!position.value || !borrowVault.value || !sourceVault.value) {
      throw new Error('Position or vaults not loaded')
    }

    if (core.isSameAsset.value) {
      const debtNano = core.debtAmount.value
        ? valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals)
        : valueToNano(core.amount.value, sourceVault.value.asset.decimals)
      const currentDebtVal = getCurrentDebt()
      const isFullRepay = debtNano >= currentDebtVal

      if (isFullRepay) {
        return buildSameAssetFullRepayPlan({
          collateralVaultAddress: sourceVault.value.address,
          borrowVaultAddress: borrowVault.value.address,
          amount: currentDebtVal,
          subAccount: position.value.subAccount,
          enabledCollaterals: position.value.collaterals,
        })
      }
      return buildSameAssetRepayPlan({
        collateralVaultAddress: sourceVault.value.address,
        borrowVaultAddress: borrowVault.value.address,
        amount: debtNano,
        subAccount: position.value.subAccount,
        enabledCollaterals: position.value.collaterals,
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
        targetDebt,
        currentDebt,
        liabilityVault: borrowVault.value.address,
        enabledCollaterals: position.value.collaterals,
        source: 'collateral',
      })
    }

    return buildSwapPlan({
      quote: core.quotes.selectedQuote.value,
      swapperMode: swapMode,
      isRepay: true,
      targetDebt,
      currentDebt,
      liabilityVault: borrowVault.value.address,
      enabledCollaterals: position.value.collaterals,
    })
  }

  const submitCowSwapClosePosition = () => {
    if (!position.value || !borrowVault.value || !sourceVault.value || !core.quotes.selectedQuote.value) return

    cowSwapExecution.reset()

    const chainId = currentChainId.value ?? 0
    const chainConfig = getCowSwapChainConfig(chainId)
    if (!chainConfig) return

    const validTo = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
    const currentDebt = getCurrentDebt()
    const swapMode = core.direction.value

    let targetDebt = 0n
    if (swapMode === SwapperMode.TARGET_DEBT && core.debtAmount.value) {
      const debtAmountNano = valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals)
      targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
    }

    const isFullRepay = targetDebt === 0n && swapMode === SwapperMode.TARGET_DEBT
    const sellAmount = BigInt(core.quotes.selectedQuote.value.amountIn)
    const buyAmount = isFullRepay
      ? currentDebt + (currentDebt / 1000n) // +0.1% buffer for interest
      : BigInt(core.quotes.selectedQuote.value.amountOutMin || core.quotes.selectedQuote.value.amountOut || '1')

    const cowParams: CowSwapClosePositionExecuteParams = {
      chainId,
      sellToken: sourceVault.value.address as Address,
      buyToken: borrowVault.value.asset.address as Address,
      sellAmount,
      buyAmount,
      validTo,
      orderKind: isFullRepay ? 'buy' : 'sell',
      wrapper: {
        owner: (address.value || zeroAddress) as Address,
        account: position.value.subAccount as Address,
        deadline: validTo,
        borrowVault: borrowVault.value.address as Address,
        collateralVault: sourceVault.value.address as Address,
        collateralAmount: sellAmount,
      },
    }

    const sourceAsset = sourceVault.value.asset
    const borrowAsset = borrowVault.value.asset

    const signSteps: DisplayStep[] = []
    let idx = 1
    signSteps.push({ index: idx++, label: 'Sign EVC permit', isSeparateTx: false })
    signSteps.push({ index: idx++, label: 'Sign CoW order', isSeparateTx: false })

    let wIdx = 1
    const wrapperSteps: DisplayStep[] = [
      { index: wIdx++, label: 'Transfer collateral to Inbox', isSeparateTx: false, assetInfo: { symbol: sourceVault.value.symbol || sourceAsset.symbol, address: sourceAsset.address, amount: core.amount.value } },
      { index: wIdx++, label: 'Swap', isSeparateTx: false, assetInfo: { symbol: sourceAsset.symbol, address: sourceAsset.address, amount: core.amount.value }, toAssetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address, amount: core.debtAmount.value || '?' } },
      { index: wIdx++, label: 'Repay debt', isSeparateTx: false, assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address } },
    ]

    const walletWarningsDescription
      = 'The CoW order operates on vault shares. The amounts shown above are in underlying assets. '
      + 'The CoW order receiver is a temporary Inbox contract — your wallet will flag this as an unfamiliar address. '
      + 'The Inbox holds funds only during settlement and returns them to your position.'

    openCowSwapReviewModal(cowModal, {
      signSteps,
      wrapperSteps,
      walletWarningsDescription,
      execution: cowSwapExecution,
      orderStatus: cowSwapOrderStatus,
      executeParams: cowParams,
      logPrefix: 'collateralSwapRepay/cowswap',
    })
  }

  // Watch for CowSwap order completion
  watch(() => cowSwapOrderStatus.orderStatus.value, (status) => {
    if (!status?.terminal) return
    if (status.type === 'traded' || status.type === 'fulfilled') {
      refreshAllPositions(eulerLensAddresses.value, address.value as string)
      setTimeout(() => router.replace('/portfolio'), 400)
    }
  })

  const submit = async () => {
    if (isPreparing.value || isSubmitting.value || !position.value || !borrowVault.value || !sourceVault.value) return
    if (!core.isSameAsset.value && !core.quotes.selectedQuote.value) return

    // CowSwap path: skip plan building and simulation
    if (isCowSwapProvider.value) {
      submitCowSwapClosePosition()
      return
    }

    isPreparing.value = true
    try {
      try {
        plan.value = await buildRepayPlan()
      }
      catch (e) {
        logWarn('collateralSwapRepay/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value)
        if (!ok) return
      }

      modal.open(OperationReviewModal, {
        props: {
          type: 'repay',
          asset: sourceVault.value.asset,
          amount: core.amount.value,
          plan: plan.value || undefined,
          swapToAsset: !core.isSameAsset.value ? borrowVault.value.asset : undefined,
          swapToAmount: !core.isSameAsset.value ? core.debtAmount.value : undefined,
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
    if (!position.value || !borrowVault.value) return
    if (!core.isSameAsset.value && !core.quotes.selectedQuote.value) return
    try {
      isSubmitting.value = true
      const txPlan = await buildRepayPlan()
      await executeTxPlan(txPlan)

      modal.close()
      refreshAllPositions(eulerLensAddresses.value, address.value as string)
      setTimeout(() => {
        router.replace('/portfolio')
      }, 400)
    }
    catch (e) {
      error('Transaction failed')
      logWarn('collateralSwapRepay/send', e)
    }
    finally {
      isSubmitting.value = false
    }
  }

  const initVault = (vault: Vault | undefined) => {
    sourceVault.value = vault
  }

  const resetOnTabSwitch = () => {
    core.resetCore()
    core.direction.value = SwapperMode.EXACT_IN
  }

  const onSourceVaultChange = (selectedIndex: number) => {
    core.onSourceVaultChange(selectedIndex, repayCollateralVaults)
  }

  return {
    // State
    amount: core.amount,
    debtAmount: core.debtAmount,
    direction: core.direction,
    debtPercent: core.debtPercent,
    sourceVault,
    sourceAssets,
    sourceBalance,
    debtBalance,
    priceInvert,
    sourceProduct,
    repayCollateralOptions,
    repayCollateralVaults,
    quotes: core.quotes,
    isSameAsset: core.isSameAsset,
    spent: core.spent,
    debtRepaid: core.debtRepaid,
    // Health metrics
    roeBefore: health.roeBefore,
    roeAfter: health.roeAfter,
    priceRatio,
    currentLtv: health.currentLtv,
    currentLiquidationLtv: health.currentLiquidationLtv,
    nextLtv: health.nextLtv,
    currentHealth: health.currentHealth,
    nextHealth: health.nextHealth,
    isHealthInsufficient,
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
    isRepayExceedsDebt: core.isRepayExceedsDebt,
    // Handlers
    onAmountInput: core.onAmountInput,
    onDebtInput: core.onDebtInput,
    onPercentInput: core.onPercentInput,
    onSourceVaultChange,
    onRefreshQuotes: core.onRefreshQuotes,
    submit,
    send,
    updateSourceBalance,
    initVault,
    resetOnTabSwitch,
  }
}
