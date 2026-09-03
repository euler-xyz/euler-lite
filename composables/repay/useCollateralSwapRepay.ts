import type { EVault, SecuritizeCollateralVault, PortfolioBorrowPosition, SwapQuote, VaultEntity, TransactionPlan, SimulationStateOverrideOptions } from '@eulerxyz/euler-v2-sdk'
import { useStateOverrideOptions } from '~/composables/useStateOverrideOptions'
import { isEVault, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'
import type { Ref, ComputedRef } from 'vue'
import { formatUnits, zeroAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { convertVaultSharesToAssets } from '~/utils/vault-utils'
import { cowSwapInboxExists } from '~/utils/cowswap-inbox'
import type { DisplayStep } from '~/utils/stepDecoding'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { getAssetOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { getBorrowPositionEffectiveLiquidationLTV } from '~/utils/ltv'
import { maxUint256 } from 'viem'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { useCrossPositionRepayCollateralOptions, type CrossPositionRepayCollateralItem } from '~/composables/useCrossPositionRepayCollateralOptions'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { useRepaySwapCore } from '~/composables/repay/useRepaySwapCore'
import { useRepaySwapDetails } from '~/composables/repay/useRepaySwapDetails'
import { useRepayHealthMetrics } from '~/composables/repay/useRepayHealthMetrics'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'
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
import { getEulerSdkFresh } from '~/composables/useEulerSdk'

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
  runSimulation: (plan: TransactionPlan, stateOverrideOptions?: SimulationStateOverrideOptions) => Promise<boolean>
  getCurrentDebt: () => bigint
  isEligibleForLiquidation: ComputedRef<boolean>
}

interface CollateralSwapRepayPlanSnapshot {
  sourceVault?: EVault
  sourceAccount?: Address
  amount?: string
  debtAmount?: string
  direction?: SwapperMode
  isSameAsset?: boolean
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
  const { error } = useToast()
  const { isConnected, address, isSpyMode, effectiveAddress } = useEffectiveAddress()
  const { planRepayFromSource, prefetchPluginData } = useEulerTx()
  const { create: createIntent } = useOperationIntentFactory()
  const { open: openReviewState } = useExecutionReview()
  // Collateral-swap repay consumes vault collateral, not wallet ERC20 — safe to
  // skip balance overrides. Slot hints + wallet snapshot still help allowance
  // overrides without firing the balance branch.
  const { primeSlotHintsFor, buildStateOverrideOptions } = useStateOverrideOptions()
  const buildRepayStateOverrideOptions = () => buildStateOverrideOptions({ noBalanceOverride: true })
  const { chainId: currentChainId } = useEulerAddresses()
  const { finalizeExecutionUi } = useTxFinalization()
  const { borrowPositions, depositPositions, refreshAllPositions } = useEulerAccount()
  const { account: planAccount } = usePlanAccount()
  const { client: rpcClient } = useRpcClient()
  const { entryCount: batchEntryCount, getMergedPlan } = useTxBatch()
  const { cowSwapForcedOff } = useCowSwapEligibility()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const { getSupplyRewardApy, getBorrowRewardApyForCollaterals } = useRewardsApy()
  const { getCollateralApySnapshot } = usePositionCollateralApy()

  // --- Source vault state ---
  const sourceVault: Ref<EVault | undefined> = ref()
  const selectedSourceAccount = ref<Address>()
  const selectedSourceId = ref<string>()
  const sourceAssets = ref(0n)
  const sourceShares = ref(0n)
  const targetAccount = computed(() => position.value?.subAccount as Address | undefined)
  const isCrossPositionSource = computed(() => !!selectedSourceAccount.value
    && !!targetAccount.value
    && normalizeAddressOrEmpty(selectedSourceAccount.value) !== normalizeAddressOrEmpty(targetAccount.value))
  const isSameVaultRepay = computed(() => !!sourceVault.value
    && !!borrowVault.value
    && normalizeAddressOrEmpty(sourceVault.value.address) === normalizeAddressOrEmpty(borrowVault.value.address))
  const sourceBalance = computed(() => getCashLimitedWithdrawAmount(
    sourceAssets.value,
    isSameVaultRepay.value ? undefined : sourceVault.value,
  ))
  const debtBalance = computed(() => position.value?.borrowed || 0n)

  const priceInvert = usePriceInvert(
    () => sourceVault.value?.asset.symbol,
    () => borrowVault.value?.asset.symbol,
  )
  const sourceProduct = useEulerProductOfVault(computed(() => sourceVault.value?.address || ''))
  const buildBatchAwareGasEstimatePlan = async (candidatePlan: TransactionPlan): Promise<TransactionPlan> => {
    const batchPlan = batchEntryCount.value > 0 ? getMergedPlan() : null
    if (!batchPlan) return candidatePlan
    const sdk = await getEulerSdkFresh()
    return sdk.executionService.mergePlans([batchPlan, candidatePlan])
  }

  // --- Collateral options ---
  const { collateralOptions: swapCollateralOptions, collateralVaults: swapCollateralVaults } = useSwapCollateralOptions({
    currentVault: computed(() => undefined),
    liabilityVault: computed(() => borrowVault.value as typeof borrowVault.value),
    tagContext: 'supply-source',
  })

  const currentRepayCollateralVaults = computed<EVault[]>(() => {
    if (!position.value) return []
    const collateralAddresses = position.value.collateralVaults
    const allowed = collateralAddresses.length
      ? new Set(collateralAddresses.map(addr => normalizeAddressOrEmpty(addr)))
      : null
    const candidates = swapCollateralVaults.value
    const filtered = allowed
      ? candidates.filter(vault => allowed.has(normalizeAddressOrEmpty(vault.address)))
      : candidates
    if (!filtered.length && collateralVault.value && isEVault(collateralVault.value)) {
      return [collateralVault.value]
    }
    return filtered
  })

  const currentRepayCollateralOptions = computed(() => {
    const allowed = new Set(currentRepayCollateralVaults.value.map(vault => normalizeAddressOrEmpty(vault.address)))
    return swapCollateralOptions.value.filter(option => allowed.has(normalizeAddressOrEmpty(option.vaultAddress)))
  })

  const currentRepayCollateralItems = computed<CrossPositionRepayCollateralItem[]>(() => {
    const currentPosition = position.value
    if (!currentPosition) return []
    const sourceAccount = currentPosition.subAccount as Address
    return currentRepayCollateralVaults.value.flatMap((vault) => {
      const option = currentRepayCollateralOptions.value.find(candidate =>
        normalizeAddressOrEmpty(candidate.vaultAddress) === normalizeAddressOrEmpty(vault.address))
      if (!option) return []
      const collateral = currentPosition.collaterals.find(candidate =>
        normalizeAddressOrEmpty(candidate.vaultAddress) === normalizeAddressOrEmpty(vault.address))
      const id = `${sourceAccount.toLowerCase()}:${vault.address.toLowerCase()}`
      return [{
        id,
        vault,
        sourceAccount,
        assets: collateral?.assets ?? 0n,
        shares: collateral?.shares ?? 0n,
        option: { ...option, selectionId: id, subAccount: sourceAccount },
      }]
    })
  })

  const { items: crossPositionRepayCollateralItems } = useCrossPositionRepayCollateralOptions({
    targetPosition: position,
    liabilityVault: borrowVault,
  })

  const repayCollateralItems = computed(() => [
    ...currentRepayCollateralItems.value,
    ...crossPositionRepayCollateralItems.value,
  ])
  const repayCollateralOptions = computed(() => repayCollateralItems.value.map(item => item.option))
  const repayCollateralVaults = computed(() => repayCollateralItems.value.map(item => item.vault))

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
    includeCowSwap: () => !isCrossPositionSource.value && !cowSwapForcedOff.value && batchEntryCount.value === 0,
    buildTxPlanForQuote: (quote, _provider, context) => buildRepayPlan(quote, context.account),
    createIntentsForQuote: quote => [createRepayIntent(quote)],
    buildGasEstimatePlan: buildBatchAwareGasEstimatePlan,
    prefetchPluginData: (plan, account, intents) => prefetchPluginData(plan, { account, intents }),
    getPlanAccount: () => planAccount.value,
    getQuoteAccounts: () => {
      const accountOut = (position.value?.subAccount || effectiveAddress.value || zeroAddress) as Address
      const accountIn = (selectedSourceAccount.value || accountOut) as Address
      return { accountIn, accountOut }
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
    return withVaultIntrinsicApy(base, sourceVault.value, enableIntrinsicApy.value) + getSupplyRewardApy(sourceVault.value.address)
  })

  const borrowApy = computed(() => {
    if (!borrowVault.value) return null
    const base = getVaultBorrowApy(borrowVault.value)
    return withVaultIntrinsicApy(base, borrowVault.value, enableIntrinsicApy.value)
  })

  const borrowRewardApy = computed(() => borrowVault.value
    ? getBorrowRewardApyForCollaterals(borrowVault.value.address, position.value?.collateralVaults ?? [])
    : 0)

  // --- Price ratio ---
  const priceRatio = computed(() => {
    if (isCrossPositionSource.value) return null
    if (!sourceVault.value || !borrowVault.value) return null
    const collateralPrice = getAssetOraclePrice(sourceVault.value)
    const borrowPrice = getAssetOraclePrice(borrowVault.value)
    return conservativePriceRatioNumber(collateralPrice, borrowPrice)
  })
  priceInvert.autoInvert(priceRatio)

  // --- Collateral-specific computeds ---
  const collateralAmountAfter = computed(() => {
    if (isCrossPositionSource.value) return null
    if (!sourceVault.value || core.spent.value === null) return null
    const nextAssets = sourceAssets.value - core.spent.value
    return nanoToValue(nextAssets > 0n ? nextAssets : 0n, sourceVault.value.shares.decimals)
  })

  const nextLiquidationLtv = computed(() => {
    if (isCrossPositionSource.value) return null
    if (!borrowVault.value || !sourceVault.value) return null
    const match = borrowVault.value.collaterals.find(
      ltv => normalizeAddressOrEmpty(ltv.address) === normalizeAddressOrEmpty(sourceVault.value?.address),
    )
    if (match) return ltvToPercent(match.liquidationLTV)
    if (!position.value) return null
    const liquidationLTV = getBorrowPositionEffectiveLiquidationLTV(position.value)
    return liquidationLTV === undefined ? null : ltvToPercent(liquidationLTV)
  })

  // --- Collateral portfolio value/APY ---
  const collateralPortfolioGuard = createRaceGuard()
  const weightedCollateralSupplyApy = ref<number | null>(null)
  const nextWeightedCollateralSupplyApy = ref<number | null>(null)
  const collateralValueUsd = ref<number | null>(null)
  const nextCollateralValueUsd = ref<number | null>(null)
  const collateralAddresses = ref<string[]>([])
  const nextCollateralAddresses = ref<string[]>([])
  const collateralSnapshotComplete = ref(false)
  const nextCollateralSnapshotComplete = ref(false)
  const collateralSnapshot = shallowRef<CollateralApySnapshot | null>(null)
  const nextCollateralSnapshot = shallowRef<CollateralApySnapshot | null>(null)

  watchEffect(async () => {
    const gen = collateralPortfolioGuard.next()
    const currentPosition = position.value
    const currentBorrowVault = borrowVault.value
    const currentSourceVault = sourceVault.value
    const spent = core.spent.value ?? 0n
    const debtRepaid = core.debtRepaid.value

    if (!currentPosition || !currentBorrowVault || !currentSourceVault) {
      weightedCollateralSupplyApy.value = null
      nextWeightedCollateralSupplyApy.value = null
      collateralValueUsd.value = null
      nextCollateralValueUsd.value = null
      collateralAddresses.value = []
      nextCollateralAddresses.value = []
      collateralSnapshotComplete.value = false
      nextCollateralSnapshotComplete.value = false
      collateralSnapshot.value = null
      nextCollateralSnapshot.value = null
      return
    }
    collateralSnapshotComplete.value = false
    nextCollateralSnapshotComplete.value = false
    collateralSnapshot.value = null
    nextCollateralSnapshot.value = null
    const sourceIsLiability = normalizeAddressOrEmpty(currentSourceVault.address)
      === normalizeAddressOrEmpty(currentBorrowVault.address)
    const repayAmount = debtRepaid === null
      ? null
      : debtRepaid > (currentPosition.borrowed || 0n)
        ? currentPosition.borrowed || 0n
        : debtRepaid
    const [currentSnapshot, nextSnapshot] = await Promise.all([
      getCollateralApySnapshot(currentPosition, currentBorrowVault),
      getCollateralApySnapshot(currentPosition, currentBorrowVault, {
        deltas: isCrossPositionSource.value
          ? []
          : [{
              vaultAddress: currentSourceVault.address,
              assetsDelta: -spent,
              cashDelta: sourceIsLiability ? 0n : -spent,
              projectRates: spent > 0n,
            }],
        ...(repayAmount !== null
          ? {
              liabilityRateDelta: {
                cashDelta: sourceIsLiability ? 0n : repayAmount,
                borrowsDelta: -repayAmount,
              },
            }
          : {}),
      }),
    ])
    if (collateralPortfolioGuard.isStale(gen)) return
    weightedCollateralSupplyApy.value = currentSnapshot.weightedSupplyApy
    nextWeightedCollateralSupplyApy.value = nextSnapshot.weightedSupplyApy
    collateralValueUsd.value = currentSnapshot.supplyUsd
    nextCollateralValueUsd.value = nextSnapshot.supplyUsd
    collateralAddresses.value = currentSnapshot.collateralAddresses ?? currentPosition.collateralVaults ?? []
    nextCollateralAddresses.value = nextSnapshot.collateralAddresses ?? currentPosition.collateralVaults ?? []
    collateralSnapshotComplete.value = currentSnapshot.isComplete
    nextCollateralSnapshotComplete.value = nextSnapshot.isComplete
    collateralSnapshot.value = currentSnapshot.isComplete ? currentSnapshot : null
    nextCollateralSnapshot.value = nextSnapshot.isComplete ? nextSnapshot : null
  })
  const effectiveCollateralSupplyApy = computed(() => weightedCollateralSupplyApy.value ?? collateralSupplyApy.value)
  const effectiveNextCollateralSupplyApy = computed(() => nextWeightedCollateralSupplyApy.value ?? effectiveCollateralSupplyApy.value)
  const nextBorrowRewardApy = computed(() => borrowVault.value
    ? getBorrowRewardApyForCollaterals(borrowVault.value.address, nextCollateralAddresses.value)
    : 0)

  // --- Health metrics ---
  const health = useRepayHealthMetrics({
    position,
    borrowVault,
    debtRepaid: core.debtRepaid,
    priceRatio,
    nextLiquidationLtv,
    collateralAmountAfter,
    collateralSupplyApy: effectiveCollateralSupplyApy,
    nextCollateralSupplyApy: effectiveNextCollateralSupplyApy,
    borrowApy,
    borrowRewardApy,
    nextBorrowRewardApy,
    collateralSnapshotComplete,
    nextCollateralSnapshotComplete,
    collateralAddresses,
    nextCollateralAddresses,
    collateralSnapshot,
    nextCollateralSnapshot,
    projectedBorrowRates: computed(() => nextCollateralSnapshot.value?.liabilityProjectedRates ?? null),
    collateralValueUsd,
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

  // Collateral-swap repay. Exact-vault path: liability.REPAY_WITH_SHARES only.
  // Same-asset cross-vault path: source.WITHDRAW + liability.SKIM +
  // liability.REPAY_WITH_SHARES. Cross-asset path: source.WITHDRAW + swap +
  // liability.REPAY (done by swapper). Same-position full repay: + collateral.TRANSFER.
  // Heuristic: for cross-asset paths, core.debtRepaid uses the quote's
  // amountOut (pre-slippage). See useSavingsRepay for the precision note.
  const isEffectivelyFullRepay = computed(() => {
    if (!position.value || (position.value.borrowed ?? 0n) <= 0n) return false
    const repaid = core.debtRepaid.value
    return repaid !== null && repaid >= (position.value.borrowed ?? 0n)
  })

  const collateralSwapRepayPlannedOps = computed<PlannedOp[]>(() => {
    const steps: PlannedOp[] = []
    if (sourceVault.value && !isSameVaultRepay.value) steps.push({ vault: sourceVault.value as EVault, op: OP_WITHDRAW })
    if (borrowVault.value) {
      if (isSameVaultRepay.value) {
        steps.push({ vault: borrowVault.value as EVault, op: OP_REPAY_WITH_SHARES })
      }
      else if (core.isSameAsset.value) {
        steps.push({ vault: borrowVault.value as EVault, op: OP_SKIM })
        steps.push({ vault: borrowVault.value as EVault, op: OP_REPAY_WITH_SHARES })
      }
      else {
        // Cross-asset: swapper internally calls repay
        steps.push({ vault: borrowVault.value as EVault, op: OP_REPAY })
      }
    }
    if (isEffectivelyFullRepay.value && !isCrossPositionSource.value) {
      for (const vault of currentRepayCollateralVaults.value) {
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
    !isSameVaultRepay.value
    && requiredInput.value > 0n
    && requiredInput.value > (sourceVault.value?.availableLiquidity ?? 0n),
  )
  const liquidityWarning = computed<VaultWarning | null>(() => {
    if (!sourceVault.value || isSameVaultRepay.value) return null
    return getUtilisationWarning(sourceVault.value, 'repay')
  })

  // --- Submit disabled ---
  const isSubmitDisabled = computed(() => {
    if (!isConnected.value && !isSpyMode.value) return true
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
  const updateSourceBalance = () => {
    if (!position.value || !sourceVault.value) {
      sourceAssets.value = 0n
      sourceShares.value = 0n
      return
    }
    let sourcePosition = borrowPositions.value.find(candidate =>
      normalizeAddressOrEmpty(candidate.subAccount) === normalizeAddressOrEmpty(selectedSourceAccount.value))
    if (!sourcePosition && normalizeAddressOrEmpty(position.value.subAccount) === normalizeAddressOrEmpty(selectedSourceAccount.value)) {
      sourcePosition = position.value
    }
    const sourceSaving = depositPositions.value.find(candidate =>
      candidate.position.isCollateral
      && normalizeAddressOrEmpty(candidate.subAccount) === normalizeAddressOrEmpty(selectedSourceAccount.value)
      && normalizeAddressOrEmpty(candidate.position.vaultAddress) === normalizeAddressOrEmpty(sourceVault.value?.address))
    if (!sourcePosition && !sourceSaving) {
      sourceAssets.value = 0n
      sourceShares.value = 0n
      return
    }
    if (sourceSaving) {
      sourceAssets.value = sourceSaving.assets
      sourceShares.value = sourceSaving.shares
      return
    }
    if (!sourcePosition) return
    const primaryAddress = normalizeAddressOrEmpty(sourcePosition.collateralVault?.address)
    const targetAddress = normalizeAddressOrEmpty(sourceVault.value.address)
    // Source collateral assets/shares from the (layer-aware) position rather than
    // a direct lens read, so it reflects the active batch layer. Unheld ⇒ 0.
    const match = sourcePosition.collaterals.find(c =>
      normalizeAddressOrEmpty(c.vaultAddress) === targetAddress)
    sourceAssets.value = match?.assets ?? (targetAddress === primaryAddress ? (sourcePosition.supplied || 0n) : 0n)
    sourceShares.value = match?.shares ?? 0n
  }

  watch([sourceVault, selectedSourceAccount, position, borrowPositions, depositPositions], () => {
    void updateSourceBalance()
  }, { immediate: true })

  // Pre-prime ERC20 slot hints for the source/borrow assets touched here. The
  // probe is owner-/spender-agnostic and reused across estimate/sim calls.
  watch(
    [sourceVault, borrowVault],
    ([source, borrow]) => {
      const tokens: Address[] = []
      const seen = new Set<string>()
      const push = (addr?: string) => {
        if (!addr) return
        const key = addr.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        tokens.push(addr as Address)
      }
      push(source?.asset?.address)
      push(borrow?.asset?.address)
      if (tokens.length) void primeSlotHintsFor(tokens)
    },
    { immediate: true },
  )

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
  async function buildRepayPlan(
    quote?: SwapQuote,
    account = planAccount.value,
    snapshot: CollateralSwapRepayPlanSnapshot = {},
  ): Promise<TransactionPlan> {
    const source = snapshot.sourceVault ?? sourceVault.value
    if (!position.value || !borrowVault.value || !source) {
      throw new Error('Position or vaults not loaded')
    }

    const subAccount = position.value.subAccount as Address
    const sourceAccount = snapshot.sourceAccount ?? selectedSourceAccount.value ?? subAccount
    const isCrossPosition = normalizeAddressOrEmpty(sourceAccount) !== normalizeAddressOrEmpty(subAccount)
    if (isCrossPosition && normalizeAddressOrEmpty(source.address) !== normalizeAddressOrEmpty(borrowVault.value.address)) {
      throw new Error('Cross-position collateral repayment requires the exact liability vault')
    }
    const sameAsset = snapshot.isSameAsset ?? core.isSameAsset.value
    const amountInput = snapshot.amount ?? core.amount.value
    const debtAmountInput = snapshot.debtAmount ?? core.debtAmount.value
    let isFullRepay: boolean
    let liabilityAmount = 0n
    let swapMode: SwapperMode | undefined

    if (sameAsset) {
      const debtNano = debtAmountInput
        ? valueToNano(debtAmountInput, borrowVault.value.asset.decimals)
        : valueToNano(amountInput, source.asset.decimals)
      const currentDebtVal = getCurrentDebt()
      isFullRepay = debtNano >= currentDebtVal
      liabilityAmount = isFullRepay ? maxUint256 : debtNano
    }
    else {
      const swapQuote = quote || core.quotes.selectedQuote.value
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
      liabilityAsset: borrowVault.value.asset.address as Address,
      liabilityAmount,
      receiver: subAccount,
      fromVault: source.address as Address,
      fromAccount: sourceAccount,
      swapQuote: sameAsset ? undefined : (quote || core.quotes.selectedQuote.value!),
      swapperMode: swapMode,
      cleanupOnMax: isFullRepay && !isCrossPosition,
      account,
    })
  }

  function createRepayIntent(
    quote?: SwapQuote,
    snapshot: CollateralSwapRepayPlanSnapshot = {},
  ) {
    const source = snapshot.sourceVault ?? sourceVault.value
    if (!position.value || !borrowVault.value || !source) throw new Error('Position or vaults not loaded')
    const subAccount = position.value.subAccount as Address
    const sourceAccount = snapshot.sourceAccount ?? selectedSourceAccount.value ?? subAccount
    const isCrossPosition = normalizeAddressOrEmpty(sourceAccount) !== normalizeAddressOrEmpty(subAccount)
    if (isCrossPosition && normalizeAddressOrEmpty(source.address) !== normalizeAddressOrEmpty(borrowVault.value.address)) {
      throw new Error('Cross-position collateral repayment requires the exact liability vault')
    }
    const sameAsset = snapshot.isSameAsset ?? core.isSameAsset.value
    const amountInput = snapshot.amount ?? core.amount.value
    const debtAmountInput = snapshot.debtAmount ?? core.debtAmount.value
    if (sameAsset) {
      const debtNano = debtAmountInput
        ? valueToNano(debtAmountInput, borrowVault.value.asset.decimals)
        : valueToNano(amountInput, source.asset.decimals)
      const isFullRepay = debtNano >= getCurrentDebt()
      return createIntent({
        kind: 'repay',
        planner: 'repay-from-deposit',
        args: {
          liabilityVault: borrowVault.value.address as Address,
          liabilityAsset: borrowVault.value.asset.address as Address,
          liabilityAmount: isFullRepay ? maxUint256 : debtNano,
          receiver: subAccount,
          fromVault: source.address as Address,
          fromAccount: sourceAccount,
          cleanupOnMax: isFullRepay && !isCrossPosition,
        },
        source: 'position/repay-collateral',
        subAccounts: isCrossPosition ? [subAccount, sourceAccount] : [subAccount],
      })
    }
    const swapQuote = quote || core.quotes.selectedQuote.value
    if (!swapQuote) throw new Error('No quote selected')
    const swapperMode = snapshot.direction ?? core.direction.value
    const currentDebt = getCurrentDebt()
    let targetDebt = 0n
    if (swapperMode === SwapperMode.TARGET_DEBT && debtAmountInput) {
      const debtAmountNano = valueToNano(debtAmountInput, borrowVault.value.asset.decimals)
      targetDebt = debtAmountNano >= currentDebt ? 0n : currentDebt - debtAmountNano
    }
    const cleanupOnMax = targetDebt === 0n && swapperMode === SwapperMode.TARGET_DEBT
    return createIntent({
      kind: 'repay',
      planner: 'repay-with-swap',
      args: { swapQuote, cleanupOnMax, swapperMode },
      source: 'position/repay-collateral',
      subAccounts: [subAccount],
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

    const sdkAccount = planAccount.value
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
      account: sdkAccount,
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
    const transferredAssets = convertVaultSharesToAssets(source, sellAmount)
    const transferredAssetAmount = nanoToValue(transferredAssets, sourceAsset.decimals)
    const transferLabelSuffix = `(Selling max ${formatNumber(transferredAssetAmount, 8, 0)} ${sourceAsset.symbol})`

    // Pre-flight whether the user's CoW inbox account already exists on chain.
    // If it does, the SDK no-ops the prep at execution time — so we omit the
    // step from the visible list to keep the step count honest. On any RPC
    // failure we keep the step (fail-closed = correct count > optimistic).
    const client = rpcClient.value
    const hasExistingInbox = client && address.value && position.value
      ? await cowSwapInboxExists({
          client,
          wrapperAddress: chainConfig.closePositionWrapper,
          owner: address.value as Address,
          subaccount: position.value.subAccount as Address,
        })
      : false

    const signSteps: DisplayStep[] = []
    let idx = 1
    if (!hasExistingInbox) {
      signSteps.push({ index: idx++, label: 'Prepare order receiver', isSeparateTx: true })
    }
    signSteps.push({ index: idx++, label: 'Sign EVC permit', isSeparateTx: false })
    signSteps.push({ index: idx, label: 'Sign CoW order', isSeparateTx: false })

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
      { index: wIdx, label: 'Repay', isSeparateTx: false, assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address } },
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
      const quoteIntents = core.quotes.selectedQuoteCard.value?.quote === core.quotes.selectedQuote.value
        ? core.quotes.selectedQuoteCard.value.intents
        : undefined
      const intents = quoteIntents?.length ? quoteIntents : [createRepayIntent()]
      try {
        plan.value = await buildRepayPlan()
      }
      catch (e) {
        logWarn('collateralSwapRepay/buildPlan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value, buildRepayStateOverrideOptions())
        if (!ok) return
      }

      const inputDisplay = getRepaySwapReviewInputAmount({
        amount: core.amount.value,
        quote: core.quotes.selectedQuote.value,
        sourceDecimals: sourceVault.value.asset.decimals,
        swapperMode: core.direction.value,
      })

      if (!plan.value) return
      await openReviewState(intents, {
        presentationKind: 'repay',
        review: {
          type: 'repay',
          asset: sourceVault.value.asset,
          amount: inputDisplay,
          quoteFetchedAt: !core.isSameAsset.value ? core.quotes.effectiveQuoteFetchedAt.value : null,
          swapToAsset: !core.isSameAsset.value ? borrowVault.value.asset : undefined,
          swapToAmount: !core.isSameAsset.value ? core.debtAmount.value : undefined,
          swapMode: !core.isSameAsset.value ? core.direction.value : undefined,
          subAccount: position.value?.subAccount,
          hasBorrows: (position.value?.borrowed || 0n) > 0n,
          submittingLabel: 'Submitting...',
        },
        onSucceeded: () => finalizeExecutionUi(),
        onFailed: (cause) => {
          error('Transaction failed')
          logWarn('collateralSwapRepay/send', cause)
        },
      })
    }
    finally {
      isPreparing.value = false
    }
  }

  const initVault = (vault: EVault | undefined) => {
    sourceVault.value = vault
    selectedSourceAccount.value = position.value?.subAccount as Address | undefined
    selectedSourceId.value = vault && selectedSourceAccount.value
      ? `${selectedSourceAccount.value.toLowerCase()}:${vault.address.toLowerCase()}`
      : undefined
  }

  watch(repayCollateralItems, (items) => {
    if (!isCrossPositionSource.value || !selectedSourceId.value) return
    if (items.some(item => item.id === selectedSourceId.value)) return
    initVault(collateralVault.value && isEVault(collateralVault.value) ? collateralVault.value : undefined)
    core.resetCore()
  })

  const resetOnTabSwitch = () => {
    core.resetCore()
    core.direction.value = SwapperMode.EXACT_IN
  }

  const onSourceVaultChange = (selectedIndex: number) => {
    const next = repayCollateralItems.value[selectedIndex]
    if (!next) return
    const changed = selectedSourceId.value !== next.id
    selectedSourceId.value = next.id
    selectedSourceAccount.value = next.sourceAccount
    sourceVault.value = next.vault
    if (changed) {
      clearSimulationError()
      core.resetCore()
    }
  }

  return {
    // State
    amount: core.amount,
    debtAmount: core.debtAmount,
    direction: core.direction,
    debtPercent: core.debtPercent,
    sourceVault,
    selectedSourceAccount,
    selectedSourceId,
    sourceAssets,
    sourceBalance,
    debtBalance,
    priceInvert,
    sourceProduct,
    repayCollateralOptions,
    repayCollateralVaults,
    quotes: core.quotes,
    isSameAsset: core.isSameAsset,
    isSameVaultRepay,
    isCrossPositionSource,
    spent: core.spent,
    debtRepaid: core.debtRepaid,
    // Health metrics
    roeBefore: health.roeBefore,
    roeAfter: health.roeAfter,
    projectedYieldDetails: health.projectedYieldDetails,
    nextCollateralAddresses,
    nextCollateralSnapshotComplete,
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
    isFullRepay,
    // Handlers
    onAmountInput: core.onAmountInput,
    onDebtInput: core.onDebtInput,
    onPercentInput: core.onPercentInput,
    onSourceVaultChange,
    onRefreshQuotes: core.onRefreshQuotes,
    onSourceMax: core.onSourceMax,
    onProviderSelect: core.onProviderSelect,
    submit,
    updateSourceBalance,
    initVault,
    resetOnTabSwitch,
    // Batch
    buildRepayPlan,
    createRepayIntent,
  }
}
