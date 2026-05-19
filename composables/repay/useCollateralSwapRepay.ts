import type { Account, EVault, IHasVaultAddress, SecuritizeCollateralVault, PortfolioBorrowPosition, SwapQuote, VaultEntity, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { isEVault, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'
import type { Ref, ComputedRef } from 'vue'
import { formatUnits, zeroAddress, type Address, type Abi } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { cowSwapInboxExists } from '~/utils/cowswap-inbox'
import type { DisplayStep } from '~/utils/stepDecoding'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import { getAssetUsdValue, getAssetOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { getBorrowPositionEffectiveLiquidationLTV } from '~/utils/ltv'
import { maxUint256 } from 'viem'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
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
import { findBlockingDisabledOp, OP_REPAY, OP_REPAY_WITH_SHARES, OP_SKIM, OP_TRANSFER, OP_WITHDRAW, type PlannedOp } from '~/utils/vault-hooks'
import { getPlanHookDisabledWarning, getUtilisationWarning, type VaultWarning } from '~/composables/useVaultWarnings'
import { COWSWAP_ORDER_DEADLINE_SECONDS, getCowSwapChainConfig, getCowSwapQuoteOrderAmounts, isCowProvider } from '~/entities/cowswap'
import { type CowSwapClosePositionExecuteParams, useCowSwapClosePositionExecution, useCowSwapOrderStatus, openCowSwapReviewModal } from '~/composables/cowswap'
import { formatNumber, trimTrailingZeros } from '~/utils/string-utils'

interface UseCollateralSwapRepayOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  collateralVault: ComputedRef<EVault | SecuritizeCollateralVault | undefined>
  formTab: Ref<string>
  plan: Ref<TransactionPlan | null>
  isSubmitting: Ref<boolean>
  isPreparing: Ref<boolean>
  slippage: Readonly<Ref<number>>
  clearSimulationError: () => void
  runSimulation: (plan: TransactionPlan) => Promise<boolean>
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
  const { isConnected, address } = useWagmi()
  const { planRepayFromSource, executePlan } = useEulerTx()
  const { eulerLensAddresses, isReady: isEulerAddressesReady, loadEulerConfig, chainId: currentChainId } = useEulerAddresses()
  const { finalizeTxAndRedirect } = useTxFinalization()
  const { refreshAllPositions } = useEulerAccount()
  const { account: freshAccount } = useFreshAccount()
  const { client: rpcClient } = useRpcClient()
  const { withIntrinsicSupplyApy, withIntrinsicBorrowApy } = useIntrinsicApy()
  const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()

  // --- Source vault state ---
  const sourceVault: Ref<EVault | undefined> = ref()
  const sourceAssets = ref(0n)
  const sourceShares = ref(0n)
  const sourceBalance = computed(() => getCashLimitedWithdrawAmount(
    sourceAssets.value,
    sourceVault.value,
  ))
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
    const collateralAddresses = position.value.collateralVaults
    const allowed = collateralAddresses.length
      ? new Set(collateralAddresses.map(addr => normalizeAddressOrEmpty(addr)))
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
    sourceAssets,
    sourceShares,
    sourceBalance,
    formTab,
    formTabName: 'collateral',
    slippage,
    clearSimulationError,
    getCurrentDebt,
    includeCowSwap: true,
    buildTxPlanForQuote: quote => buildRepayPlan(quote),
    getQuoteAccounts: () => {
      const subAccount = (position.value?.subAccount || address.value || zeroAddress) as Address
      return { accountIn: subAccount, accountOut: subAccount }
    },
  })

  // --- CowSwap close position ---
  const cowModal = useModal()
  const cowSwapExecution = useCowSwapClosePositionExecution()
  const cowSwapOrderStatus = useCowSwapOrderStatus(
    computed(() => cowSwapExecution.orderUid.value),
    currentChainId,
  )
  const isCowSwapProvider = computed(() =>
    isCowProvider(core.quotes.selectedProvider.value),
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
    const base = getVaultSupplyApy(sourceVault.value)
    return withIntrinsicSupplyApy(base, sourceVault.value.asset.address) + getSupplyRewardApy(sourceVault.value.address)
  })

  const borrowApy = computed(() => {
    if (!borrowVault.value) return null
    const base = getVaultBorrowApy(borrowVault.value)
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
    return nanoToValue(nextAssets > 0n ? nextAssets : 0n, sourceVault.value.shares.decimals)
  })

  const nextLiquidationLtv = computed(() => {
    if (!borrowVault.value || !sourceVault.value) return null
    const match = borrowVault.value.collaterals.find(
      ltv => normalizeAddressOrEmpty(ltv.address) === normalizeAddressOrEmpty(sourceVault.value?.address),
    )
    if (match) return ltvToPercent(match.liquidationLTV)
    if (!position.value) return null
    const liquidationLTV = getBorrowPositionEffectiveLiquidationLTV(position.value)
    return liquidationLTV === undefined ? null : ltvToPercent(liquidationLTV)
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
    if (sourceVault.value) steps.push({ vault: sourceVault.value as EVault, op: OP_WITHDRAW })
    if (borrowVault.value) {
      if (core.isSameAsset.value) {
        // Same-asset: withdraw → skim → repayWithShares
        steps.push({ vault: borrowVault.value as EVault, op: OP_SKIM })
        steps.push({ vault: borrowVault.value as EVault, op: OP_REPAY_WITH_SHARES })
      }
      else {
        // Cross-asset: swapper internally calls repay
        steps.push({ vault: borrowVault.value as EVault, op: OP_REPAY })
      }
    }
    if (isEffectivelyFullRepay.value) {
      for (const vault of repayCollateralVaults.value) {
        if (isEVault(vault)) {
          steps.push({ vault, op: OP_TRANSFER })
        }
      }
    }
    return steps
  })

  const hookWarning = computed(() => getPlanHookDisabledWarning(collateralSwapRepayPlannedOps.value))

  // Uses amountInMax (slippage-padded) when available so the user sees an
  // insufficient-balance error before hitting an on-chain revert.
  const requiredInput = computed(() => {
    if (core.isSameAsset.value) {
      const spent = core.spent.value ?? 0n
      return isEffectivelyFullRepay.value ? adjustForInterest(spent) : spent
    }
    const q = core.quotes.selectedQuote.value
    if (!q) return 0n
    return getSwapInputAmount(q, core.direction.value)
  })
  const isInsufficientSource = computed(() => requiredInput.value > 0n && requiredInput.value > sourceAssets.value)
  const isInsufficientVaultLiquidity = computed(() =>
    requiredInput.value > 0n && requiredInput.value > (sourceVault.value?.availableLiquidity ?? 0n),
  )
  const liquidityWarning = computed<VaultWarning | null>(() => {
    if (!sourceVault.value) return null
    return getUtilisationWarning(sourceVault.value, 'repay')
  })

  // --- Submit disabled ---
  const isSubmitDisabled = computed(() => {
    if (!isConnected.value) return false
    if (findBlockingDisabledOp(collateralSwapRepayPlannedOps.value)) return true
    if (!sourceVault.value || !borrowVault.value) return true
    if (!core.debtAmount.value && !core.amount.value) return true
    if (isInsufficientSource.value) return true
    if (isInsufficientVaultLiquidity.value) return true
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
      return 'Repay amount exceeds outstanding debt'
    }
    if (isInsufficientSource.value) {
      return 'Insufficient collateral balance to cover the required swap amount.'
    }
    if (isInsufficientVaultLiquidity.value) {
      return 'Not enough liquidity in the collateral vault.'
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
      sourceShares.value = 0n
      return
    }
    const primaryAddress = normalizeAddressOrEmpty(position.value.collateralVault?.address)
    const targetAddress = normalizeAddressOrEmpty(sourceVault.value.address)
    sourceAssets.value = targetAddress === primaryAddress ? (position.value.supplied || 0n) : 0n
    sourceShares.value = 0n

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
      }) as { assets: bigint, shares: bigint }
      sourceAssets.value = res.assets
      sourceShares.value = res.shares
    }
    catch (e) {
      logWarn('collateralSwapRepay/loadBalance', e)
    }
  }

  watch([sourceVault, position], () => {
    void updateSourceBalance()
  }, { immediate: true })

  // --- Build / Submit / Send ---
  async function buildRepayPlan(quote?: SwapQuote): Promise<TransactionPlan> {
    if (!position.value || !borrowVault.value || !sourceVault.value) {
      throw new Error('Position or vaults not loaded')
    }

    const subAccount = position.value.subAccount as Address
    let isFullRepay: boolean
    let liabilityAmount = 0n
    let swapMode: SwapperMode | undefined

    if (core.isSameAsset.value) {
      const debtNano = core.debtAmount.value
        ? valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals)
        : valueToNano(core.amount.value, sourceVault.value.asset.decimals)
      const currentDebtVal = getCurrentDebt()
      isFullRepay = debtNano >= currentDebtVal
      liabilityAmount = isFullRepay ? maxUint256 : debtNano
    }
    else {
      const swapQuote = quote || core.quotes.selectedQuote.value
      if (!swapQuote) {
        throw new Error('No quote selected')
      }
      swapMode = core.direction.value
      const currentDebt = getCurrentDebt()
      let targetDebt = 0n
      if (swapMode === SwapperMode.TARGET_DEBT && core.debtAmount.value) {
        const debtAmountNano = valueToNano(core.debtAmount.value, borrowVault.value.asset.decimals)
        targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
      }
      isFullRepay = targetDebt === 0n && swapMode === SwapperMode.TARGET_DEBT
    }

    return planRepayFromSource({
      liabilityVault: borrowVault.value.address as Address,
      liabilityAmount,
      receiver: subAccount,
      fromVault: sourceVault.value.address as Address,
      fromAccount: subAccount,
      swapQuote: core.isSameAsset.value ? undefined : (quote || core.quotes.selectedQuote.value!),
      swapperMode: swapMode,
      cleanupOnMax: isFullRepay,
    })
  }

  const submitCowSwapClosePosition = async () => {
    if (!position.value || !borrowVault.value || !sourceVault.value || !core.quotes.selectedQuote.value || !address.value) return
    if (isHealthInsufficient.value) return
    if (core.isRepayExceedsDebt.value) return

    cowSwapExecution.reset()

    const chainId = currentChainId.value ?? 0
    const chainConfig = getCowSwapChainConfig(chainId)
    if (!chainConfig) return

    const sdkAccount = freshAccount.value
    if (!sdkAccount) {
      error('Account not ready')
      return
    }

    const validTo = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
    const swapMode = core.direction.value
    const isTargetDebt = swapMode === SwapperMode.TARGET_DEBT

    // Target-debt mode always uses a BUY order. The quote fixes buyAmount
    // and the wrapper returns any unused collateral to the subaccount.
    const orderKind: 'buy' | 'sell' = isTargetDebt ? 'buy' : 'sell'

    const quote = core.quotes.selectedQuote.value
    // Compute order amounts for display in the review modal. The SDK plan
    // builder will re-derive these internally for the actual order.
    const orderAmounts = getCowSwapQuoteOrderAmounts(quote, {
      slippage: slippage.value,
      slippageTarget: 'sellAmount',
      maxSellAmount: isTargetDebt && sourceShares.value > 0n ? sourceShares.value : undefined,
    })
    if (!orderAmounts) {
      error('Invalid quote: missing CoW order amounts')
      return
    }
    const { sellAmount } = orderAmounts

    const cowParams: CowSwapClosePositionExecuteParams = {
      chainId,
      account: sdkAccount as Account<IHasVaultAddress>,
      swapQuote: quote,
      swapperMode: swapMode,
      slippage: slippage.value,
      validTo,
      orderKind,
      maxSellAmount: isTargetDebt && sourceShares.value > 0n ? sourceShares.value : undefined,
    }

    const source = sourceVault.value
    const sourceAsset = source.asset
    const borrowAsset = borrowVault.value.asset
    const transferredShareAmount = trimTrailingZeros(formatUnits(sellAmount, Number(source.shares.decimals)))
    const transferredAssets = source.totalShares > 0n
      ? (sellAmount * source.totalAssets) / source.totalShares
      : sellAmount
    const transferredAssetAmount = nanoToValue(transferredAssets, sourceAsset.decimals)
    const transferLabelSuffix = `(Selling max ${formatNumber(transferredAssetAmount, 8, 0)} ${sourceAsset.symbol})`

    // Pre-flight whether the user's CoW inbox account already exists on chain.
    // If it does, the SDK no-ops the prep at execution time — so we omit the
    // step from the visible list to keep the step count honest. On any RPC
    // failure we keep the step (fail-closed = correct count > optimistic).
    const client = rpcClient.value
    const hasExistingInbox = client && address.value
      ? await cowSwapInboxExists({
          client,
          wrapperAddress: chainConfig.closePositionWrapper,
          owner: address.value as Address,
          subaccount: sdkAccount.address as Address,
        })
      : false

    const signSteps: DisplayStep[] = []
    let idx = 1
    if (!hasExistingInbox) {
      signSteps.push({ index: idx++, label: 'Prepare order receiver', isSeparateTx: true })
    }
    signSteps.push({ index: idx++, label: 'Sign EVC permit', isSeparateTx: false })
    signSteps.push({ index: idx++, label: 'Sign CoW order', isSeparateTx: false })

    let wIdx = 1
    const wrapperSteps: DisplayStep[] = [
      {
        index: wIdx++,
        label: 'Transfer collateral to Inbox',
        labelSuffix: transferLabelSuffix,
        isSeparateTx: false,
        assetInfo: {
          symbol: source.shares.symbol || sourceAsset.symbol,
          address: source.address,
          iconAddress: sourceAsset.address,
          amount: transferredShareAmount,
        },
      },
      { index: wIdx++, label: 'Swap', isSeparateTx: false, assetInfo: { symbol: sourceAsset.symbol, address: sourceAsset.address, amount: core.amount.value }, toAssetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address, amount: core.debtAmount.value || '?' } },
      { index: wIdx++, label: 'Repay', isSeparateTx: false, assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address } },
    ]

    const walletWarningsDescription
      = 'The CoW order and Inbox transfer use vault-share amounts. Swap and repay amounts are shown in underlying assets. '
        + 'The CoW order receiver is a temporary Inbox contract — your wallet will flag this as an unfamiliar address. '
        + 'The Inbox holds funds only during settlement and returns them to your position.'

    openCowSwapReviewModal(cowModal, {
      signSteps,
      wrapperSteps,
      walletWarningsDescription,
      execution: cowSwapExecution,
      orderStatus: cowSwapOrderStatus,
      executeParams: cowParams,
      quoteFetchedAt: core.quotes.effectiveQuoteFetchedAt.value,
      logPrefix: 'collateralSwapRepay/cowswap',
    })
  }

  // Watch for CowSwap order completion → refresh portfolio + bounce to it.
  watch(() => cowSwapOrderStatus.orderStatus.value, (status) => {
    if (!status?.terminal) return
    if (status.type === 'traded' || status.type === 'fulfilled') {
      refreshAllPositions()
      cowModal.close()
      setTimeout(() => {
        router.replace('/portfolio')
        cowSwapExecution.reset()
      }, 400)
    }
    // else: leave terminal status visible until user dismisses.
  })

  const submit = async () => {
    if (isPreparing.value || isSubmitting.value || !position.value || !borrowVault.value || !sourceVault.value) return
    if (!core.isSameAsset.value && !core.quotes.selectedQuote.value) return

    // CowSwap path: skip plan building and simulation
    if (isCowSwapProvider.value) {
      await submitCowSwapClosePosition()
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
          plan: plan.value || undefined,
          quoteFetchedAt: !core.isSameAsset.value ? core.quotes.effectiveQuoteFetchedAt.value : null,
          swapToAsset: !core.isSameAsset.value ? borrowVault.value.asset : undefined,
          swapToAmount: !core.isSameAsset.value ? core.debtAmount.value : undefined,
          swapMode: !core.isSameAsset.value ? core.direction.value : undefined,
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
      await executePlan(txPlan)
      await finalizeTxAndRedirect()
    }
    catch (e) {
      error('Transaction failed')
      logWarn('collateralSwapRepay/send', e)
    }
    finally {
      isSubmitting.value = false
    }
  }

  const initVault = (vault: EVault | undefined) => {
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
