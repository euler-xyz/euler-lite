<script setup lang="ts">
import {
  isSecuritizeCollateralVault,
  SwapperMode,
  type EVault,
  type PortfolioBorrowPosition,
  type SecuritizeCollateralVault,
  type SwapQuote,
  type TransactionPlan,
  type TransactionPlanPrepared,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { erc20Abi, formatUnits, getAddress, maxUint256, zeroAddress, type Address } from 'viem'
import { OperationReviewModal, SlippageSettingsModal } from '#components'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useSwapDebtOptions } from '~/composables/useSwapDebtOptions'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { useSwapQuotesParallel, type SwapQuotePlanContext } from '~/composables/useSwapQuotesParallel'
import type { PlanRefinancePositionInput } from '~/composables/useEulerTx'
import type { CowSwapCollateralSwapExecuteParams } from '~/composables/cowswap'
import { useCowSwapCollateralSwapExecution, useCowSwapOrderStatus, openCowSwapReviewModal, buildApprovalSignSteps } from '~/composables/cowswap'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { getQuoteAmount } from '~/utils/swapQuotes'
import { isSameUnderlyingAsset } from '~/utils/vault-utils'
import { getAssetUsdValue, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { areRoeCollateralVaultsCorrelatedWithBorrow } from '~/utils/position-roe'
import { formatNumber, formatSmartAmount, formatHealthScore, trimTrailingZeros } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer, calculateRoe } from '~/utils/repayUtils'
import { ltvToPercent, nanoToValue } from '~/utils/crypto-utils'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { getPlanHookDisabledWarning } from '~/composables/useVaultWarnings'
import type { DisplayStep } from '~/utils/stepDecoding'
import {
  COWSWAP_ORDER_DEADLINE_SECONDS,
  COWSWAP_PROVIDER_EXTRA_DATA,
  buildCollateralSwapQuoteAppData,
  getCowSwapChainConfig,
  getCowSwapQuoteOrderAmounts,
  isCowProviderOrQuote,
} from '~/entities/cowswap'
import {
  isOpDisabled,
  OP_BORROW,
  OP_REDEEM,
  OP_REPAY,
  OP_REPAY_WITH_SHARES,
  OP_SKIM,
  OP_WITHDRAW,
  type PlannedOp,
} from '~/utils/vault-hooks'
import { logWarn } from '~/utils/errorHandling'
import { isOperationBlocked, registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import type { CollateralOption } from '~/types/collateral-option'

const route = useRoute()
const router = useRouter()
const modal = useModal()
const { error: showError } = useToast()
const { isConnected, address } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const { isPositionsLoaded, isPositionsLoading, getPositionBySubAccountIndex, refreshAllPositions } = useEulerAccount()
const { chainId: currentChainId } = useEulerAddresses()
const { client: rpcClient } = useRpcClient()
const {
  planRefinancePosition,
  executePreparedPlan,
  executePlan,
  prepareTransactionPlan,
  prefetchPluginData,
} = useEulerTx()
const { account: planAccount } = usePlanAccount()
const { primeSlotHintsFor, buildStateOverrideOptions } = useStateOverrideOptions()
const { runPreparedSimulation, runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const { settings } = useUserSettings()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { getTokenCategoryTags } = useTokenList()
const { getVaultCategory, getVault } = useVaultRegistry()
const cowSwapExecution = useCowSwapCollateralSwapExecution()
const cowSwapOrderStatus = useCowSwapOrderStatus(
  computed(() => cowSwapExecution.orderUid.value),
  currentChainId,
)

const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const positionIndex = usePositionIndex()

const position: Ref<PortfolioBorrowPosition<VaultEntity> | null> = ref(null)
const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const plan = shallowRef<TransactionPlan | null>(null)
const preparedPlan = shallowRef<TransactionPlanPrepared | null>(null)

const sourceDebtVault = computed<EVault | undefined>(() =>
  position.value ? position.value.borrowVault as EVault | undefined : undefined,
)
const selectedCollateralAddress = computed(() =>
  typeof route.query.collateral === 'string' ? normalizeVaultAddress(route.query.collateral) : '',
)
const sourceCollateralVault = computed<EVault | SecuritizeCollateralVault | undefined>(() => {
  const currentPosition = position.value
  if (!currentPosition) return undefined

  if (selectedCollateralAddress.value) {
    const selectedCollateral = currentPosition.collaterals.find(collateral =>
      normalizeVaultAddress(collateral.vaultAddress) === selectedCollateralAddress.value
      || normalizeVaultAddress(collateral.vault?.address) === selectedCollateralAddress.value,
    )
    const selectedVault = selectedCollateral?.vault ?? getVault(selectedCollateralAddress.value)
    if (selectedVault) return selectedVault as EVault | SecuritizeCollateralVault
  }

  return currentPosition.collateralVault as EVault | SecuritizeCollateralVault | undefined
})
const sourceCollateralEVault = computed<EVault | undefined>(() => {
  const vault = sourceCollateralVault.value
  if (!vault || isSecuritizeCollateralVault(vault)) return undefined
  return vault as EVault
})
const targetDebtVault = ref<EVault | undefined>()
const targetCollateralVault = ref<EVault | undefined>()

const effectiveDebtVault = computed<EVault | undefined>(() => targetDebtVault.value || sourceDebtVault.value)
const effectiveCollateralVault = computed<EVault | SecuritizeCollateralVault | undefined>(() =>
  targetCollateralVault.value || sourceCollateralVault.value,
)
const effectiveCollateralEVaultForOptions = computed<EVault | SecuritizeCollateralVault | undefined>(() =>
  targetCollateralVault.value || sourceCollateralVault.value,
)

useOperationGuard(computed(() => [
  sourceDebtVault.value?.address,
  sourceCollateralVault.value?.address,
  targetDebtVault.value?.address,
  targetCollateralVault.value?.address,
].filter(Boolean)))

const pairAssetsLabel = usePositionPairLabel(position)
const currentDebt = computed(() => position.value?.borrowed || 0n)
const sourceCollateralPosition = computed(() => {
  const sourceAddress = normalizeVaultAddress(sourceCollateralVault.value?.address)
  if (!sourceAddress) return null
  const matchedCollateral = position.value?.collaterals.find(collateral =>
    normalizeVaultAddress(collateral.vaultAddress) === sourceAddress
    || normalizeVaultAddress(collateral.vault?.address) === sourceAddress,
  )
  if (matchedCollateral) return matchedCollateral
  const primaryCollateral = position.value?.collateral
  return primaryCollateral && normalizeVaultAddress(primaryCollateral.vaultAddress) === sourceAddress
    ? primaryCollateral
    : null
})
const currentCollateralAssets = computed(() => sourceCollateralPosition.value?.assets ?? position.value?.supplied ?? 0n)
const currentCollateralShares = computed(() => sourceCollateralPosition.value?.shares ?? 0n)
const subAccount = computed<Address>(() =>
  (position.value?.subAccount || address.value || zeroAddress) as Address,
)
const cowSwapOwner = computed<Address>(() =>
  (address.value || (isSpyMode.value ? spyAddress.value : undefined) || zeroAddress) as Address,
)

const hasDebtChange = computed(() => !!targetDebtVault.value && !!sourceDebtVault.value)
const hasCollateralChange = computed(() => !!targetCollateralVault.value && !!sourceCollateralEVault.value)
const hasAnyChange = computed(() => hasDebtChange.value || hasCollateralChange.value)
const isSameDebtAsset = computed(() =>
  !!targetDebtVault.value && isSameUnderlyingAsset(sourceDebtVault.value, targetDebtVault.value),
)
const isSameCollateralAsset = computed(() =>
  !!targetCollateralVault.value && isSameUnderlyingAsset(sourceCollateralEVault.value, targetCollateralVault.value),
)
const debtNeedsSwap = computed(() => hasDebtChange.value && !isSameDebtAsset.value)
const collateralNeedsSwap = computed(() => hasCollateralChange.value && !isSameCollateralAsset.value)

const sourceCollateralIsEscrow = computed(() =>
  !!sourceCollateralVault.value && getVaultCategory(sourceCollateralVault.value.address) === 'escrow',
)
const collateralMigrationDisabledReason = computed(() => {
  const source = sourceCollateralVault.value
  const sourceEVault = sourceCollateralEVault.value
  if (!source) return null
  if (isSecuritizeCollateralVault(source)) {
    return 'Collateral migration is unavailable for Securitize collateral. You can still refinance the debt vault.'
  }
  if (sourceCollateralIsEscrow.value) {
    return 'Collateral migration is unavailable for escrow collateral. You can still refinance the debt vault.'
  }
  if (!sourceEVault) return null
  if (isOpDisabled(sourceEVault, OP_WITHDRAW) && isOpDisabled(sourceEVault, OP_REDEEM)) {
    return 'Collateral migration is unavailable while withdrawals are disabled on the source collateral vault.'
  }
  return null
})
const canChangeCollateral = computed(() => !collateralMigrationDisabledReason.value && !!sourceCollateralEVault.value)

const {
  borrowOptions: rawDebtTargetOptions,
  borrowVaults: rawDebtTargetVaults,
  allBorrowOptions: rawAllDebtTargetOptions,
  allBorrowVaults: rawAllDebtTargetVaults,
} = useSwapDebtOptions({
  collateralVault: effectiveCollateralEVaultForOptions,
  currentBorrowVault: computed(() => sourceDebtVault.value),
})

const debtSourceOperationAllowed = (target: EVault) => {
  const source = sourceDebtVault.value
  if (!source) return false
  if (isSameUnderlyingAsset(source, target)) {
    return !isOpDisabled(source, OP_SKIM) && !isOpDisabled(source, OP_REPAY_WITH_SHARES)
  }
  return !isOpDisabled(source, OP_REPAY)
}

const eligibleDebtTargetVaults = computed(() =>
  rawDebtTargetVaults.value.filter(vault => debtSourceOperationAllowed(vault)),
)
const eligibleDebtTargetAddressSet = computed(() =>
  new Set(eligibleDebtTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const debtBridgeTargetVaults = computed(() =>
  rawAllDebtTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return debtSourceOperationAllowed(vault) && !eligibleDebtTargetAddressSet.value.has(address)
  }),
)
const debtBridgeTargetAddressSet = computed(() =>
  new Set(debtBridgeTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const debtTargetVaults = computed(() => [
  ...eligibleDebtTargetVaults.value,
  ...debtBridgeTargetVaults.value,
])
const debtCompatibilityWarning = computed(() => ({
  title: 'Collateral migration required',
  message: 'These don\'t accept your current collateral. Pick one only if you also move collateral to a compatible vault.',
}))
const debtTargetOptions = computed(() =>
  [
    ...rawDebtTargetOptions.value.filter(option =>
      option.vaultAddress && eligibleDebtTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
    ),
    ...rawAllDebtTargetOptions.value
      .filter(option =>
        option.vaultAddress && debtBridgeTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
      )
      .map(option => ({
        ...option,
        compatibilityWarning: debtCompatibilityWarning.value,
      })),
  ],
)

const {
  collateralOptions: rawCollateralTargetOptions,
  collateralVaults: rawCollateralTargetVaults,
  allCollateralOptions: rawAllCollateralTargetOptions,
  allCollateralVaults: rawAllCollateralTargetVaults,
} = useSwapCollateralOptions({
  currentVault: sourceCollateralEVault,
  liabilityVault: computed(() => effectiveDebtVault.value),
})

const collateralSourceOperationAllowed = (target: EVault) => {
  const source = sourceCollateralEVault.value
  if (!source) return false
  return isSameUnderlyingAsset(source, target)
    ? !isOpDisabled(source, OP_REDEEM)
    : !isOpDisabled(source, OP_WITHDRAW)
}

const eligibleCollateralTargetVaults = computed(() => {
  if (!canChangeCollateral.value) return []
  return rawCollateralTargetVaults.value.filter(vault => collateralSourceOperationAllowed(vault))
})
const eligibleCollateralTargetAddressSet = computed(() =>
  new Set(eligibleCollateralTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const collateralBridgeTargetVaults = computed(() => {
  if (!canChangeCollateral.value) return []
  return rawAllCollateralTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return collateralSourceOperationAllowed(vault) && !eligibleCollateralTargetAddressSet.value.has(address)
  })
})
const collateralBridgeTargetAddressSet = computed(() =>
  new Set(collateralBridgeTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const collateralTargetVaults = computed(() => [
  ...eligibleCollateralTargetVaults.value,
  ...collateralBridgeTargetVaults.value,
])
const collateralCompatibilityWarning = computed(() => ({
  title: 'Debt migration required',
  message: 'These aren\'t accepted by your current debt. Pick one only if you also move debt to a compatible vault.',
}))
const collateralTargetOptions = computed(() =>
  [
    ...rawCollateralTargetOptions.value.filter(option =>
      option.vaultAddress && eligibleCollateralTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
    ),
    ...rawAllCollateralTargetOptions.value
      .filter(option =>
        option.vaultAddress && collateralBridgeTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
      )
      .map(option => ({
        ...option,
        compatibilityWarning: collateralCompatibilityWarning.value,
      })),
  ],
)

const currentDebtOption = computed<CollateralOption | null>(() => {
  const vault = sourceDebtVault.value
  if (!vault) return null
  const option = makeVaultOption(vault, fromBorrowApy.value ?? undefined, 'Keep current debt')
  if (targetCollateralVault.value && !isDebtCollateralCompatible(vault, targetCollateralVault.value)) {
    option.compatibilityWarning = debtCompatibilityWarning.value
  }
  return option
})
const debtSelectionOptions = computed(() => [
  ...(currentDebtOption.value ? [currentDebtOption.value] : []),
  ...debtTargetOptions.value,
])
const debtSelectionVaults = computed(() => [
  ...(sourceDebtVault.value ? [sourceDebtVault.value] : []),
  ...debtTargetVaults.value,
])

const currentCollateralOption = computed<CollateralOption | null>(() => {
  const vault = sourceCollateralVault.value
  if (!vault) return null
  const option = makeVaultOption(vault, fromSupplyApy.value ?? undefined, 'Keep current collateral')
  if (targetDebtVault.value && !isDebtCollateralCompatible(targetDebtVault.value, vault)) {
    option.compatibilityWarning = collateralCompatibilityWarning.value
  }
  return option
})
const collateralSelectionOptions = computed(() => [
  ...(currentCollateralOption.value ? [currentCollateralOption.value] : []),
  ...collateralTargetOptions.value,
])
const collateralSelectionVaults = computed(() => [
  ...(sourceCollateralVault.value ? [sourceCollateralVault.value] : []),
  ...collateralTargetVaults.value,
])

const { slippage } = useSlippage({
  fromSymbol: () => sourceCollateralVault.value?.asset.symbol || sourceDebtVault.value?.asset.symbol,
  toSymbol: () => targetCollateralVault.value?.asset.symbol || targetDebtVault.value?.asset.symbol,
})

const buildRefinanceStateOverrideOptions = () => buildStateOverrideOptions({ noBalanceOverride: true })
const currentPlanAccount = () => planAccount.value
const planContextAccount = (context?: SwapQuotePlanContext) => context?.account ?? planAccount.value

const buildRefinancePlan = async (
  options: {
    collateralQuote?: SwapQuote | null
    debtQuote?: SwapQuote | null
    includeIncomplete?: boolean
    context?: SwapQuotePlanContext
  } = {},
): Promise<TransactionPlan> => {
  if (!position.value || !sourceDebtVault.value || !sourceCollateralVault.value) {
    throw new Error('Position is not loaded')
  }

  const input: PlanRefinancePositionInput = {
    account: planContextAccount(options.context),
  }

  if (hasCollateralChange.value) {
    if (!sourceCollateralEVault.value || !targetCollateralVault.value) {
      throw new Error('Collateral vaults are not loaded')
    }
    const quote = options.collateralQuote ?? selectedCollateralQuote.value
    if (!isSameCollateralAsset.value && !quote) {
      if (!options.includeIncomplete) throw new Error('No collateral quote selected')
    }
    else {
      input.collateral = {
        fromVault: sourceCollateralEVault.value.address as Address,
        toVault: targetCollateralVault.value.address as Address,
        amount: currentCollateralAssets.value,
        positionAccount: subAccount.value,
        fromAsset: sourceCollateralEVault.value.asset.address as Address,
        toAsset: targetCollateralVault.value.asset.address as Address,
        isMax: true,
        enableCollateralTo: true,
        disableCollateralFrom: true,
        swapQuote: isSameCollateralAsset.value ? undefined : quote!,
        swapperMode: SwapperMode.EXACT_IN,
      }
    }
  }

  if (hasDebtChange.value) {
    if (!targetDebtVault.value) {
      throw new Error('Debt vault is not loaded')
    }
    const quote = options.debtQuote ?? selectedDebtQuote.value
    if (!isSameDebtAsset.value && !quote) {
      if (!options.includeIncomplete) throw new Error('No debt quote selected')
    }
    else {
      input.debt = {
        oldLiabilityVault: sourceDebtVault.value.address as Address,
        newLiabilityVault: targetDebtVault.value.address as Address,
        liabilityAccount: subAccount.value,
        liabilityAmount: currentDebt.value,
        oldLiabilityAsset: sourceDebtVault.value.asset.address as Address,
        newLiabilityAsset: targetDebtVault.value.asset.address as Address,
        swapQuote: isSameDebtAsset.value ? undefined : quote!,
        swapperMode: SwapperMode.TARGET_DEBT,
      }
    }
  }

  if (!input.collateral && !input.debt) {
    throw new Error('No refinance changes selected')
  }

  return planRefinancePosition(input)
}

const canRequestCollateralCowSwap = computed(() =>
  collateralNeedsSwap.value
  && !hasDebtChange.value
  && currentCollateralShares.value > 0n
  && !!getCowSwapChainConfig(currentChainId.value ?? 0),
)

const buildCollateralCowProviderExtraData = () => {
  if (!sourceCollateralEVault.value || !targetCollateralVault.value) return undefined
  const chainConfig = getCowSwapChainConfig(currentChainId.value ?? 0)
  if (!chainConfig || currentCollateralShares.value <= 0n) return undefined

  const quoteDeadline = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
  return {
    ...COWSWAP_PROVIDER_EXTRA_DATA.collateralSwap(currentCollateralShares.value),
    appData: buildCollateralSwapQuoteAppData(
      {
        owner: cowSwapOwner.value,
        account: subAccount.value,
        deadline: quoteDeadline,
        fromVault: sourceCollateralEVault.value.address as Address,
        toVault: targetCollateralVault.value.address as Address,
        fromAmount: currentCollateralShares.value,
        disableSourceCollateral: true,
      },
      chainConfig.collateralSwapWrapper,
      Math.round(slippage.value * 100),
    ),
  }
}

const {
  sortedQuoteCards: collateralQuoteCardsSorted,
  selectedProvider: collateralSelectedProvider,
  selectedQuote: selectedCollateralQuote,
  effectiveQuote: collateralQuote,
  effectiveQuoteFetchedAt: collateralQuoteFetchedAt,
  isLoading: isCollateralQuoteLoading,
  quoteError: collateralQuoteError,
  statusLabel: collateralQuotesStatusLabel,
  getQuoteDiffPct: getCollateralQuoteDiffPct,
  reset: resetCollateralQuotes,
  requestQuotes: requestCollateralQuotesNow,
  selectProvider: selectCollateralProvider,
} = useSwapQuotesParallel({
  amountField: 'amountOut',
  compare: 'max',
  includeCowSwap: () => canRequestCollateralCowSwap.value,
  buildTxPlanForQuote: (quote, _provider, context) => buildRefinancePlan({
    collateralQuote: quote,
    debtQuote: selectedDebtQuote.value,
    includeIncomplete: true,
    context,
  }),
  getPlanAccount: () => currentPlanAccount(),
  getStateOverrideOptions: () => buildRefinanceStateOverrideOptions(),
  prefetchPluginData: (candidatePlan, account) => prefetchPluginData(candidatePlan, { account }),
  prepareTransactionPlan: (candidatePlan, account, prefetch) => prepareTransactionPlan(candidatePlan, { account, prefetch }),
})

const {
  sortedQuoteCards: debtQuoteCardsSorted,
  selectedProvider: debtSelectedProvider,
  selectedQuote: selectedDebtQuote,
  effectiveQuote: debtQuote,
  effectiveQuoteFetchedAt: debtQuoteFetchedAt,
  isLoading: isDebtQuoteLoading,
  quoteError: debtQuoteError,
  statusLabel: debtQuotesStatusLabel,
  getQuoteDiffPct: getDebtQuoteDiffPct,
  reset: resetDebtQuotes,
  requestQuotes: requestDebtQuotesNow,
  selectProvider: selectDebtProvider,
} = useSwapQuotesParallel({
  amountField: 'amountIn',
  compare: 'min',
  buildTxPlanForQuote: (quote, _provider, context) => buildRefinancePlan({
    collateralQuote: selectedCollateralQuote.value,
    debtQuote: quote,
    includeIncomplete: true,
    context,
  }),
  getPlanAccount: () => currentPlanAccount(),
  getStateOverrideOptions: () => buildRefinanceStateOverrideOptions(),
  prefetchPluginData: (candidatePlan, account) => prefetchPluginData(candidatePlan, { account }),
  prepareTransactionPlan: (candidatePlan, account, prefetch) => prepareTransactionPlan(candidatePlan, { account, prefetch }),
})

const isSelectedCollateralCowSwapProvider = computed(() =>
  isCowProviderOrQuote(collateralSelectedProvider.value, selectedCollateralQuote.value),
)

const requestCollateralQuotes = useDebounceFn(async () => {
  if (!collateralNeedsSwap.value || !sourceCollateralEVault.value || !targetCollateralVault.value || currentCollateralAssets.value <= 0n) {
    resetCollateralQuotes()
    return
  }
  const providerExtraData = canRequestCollateralCowSwap.value
    ? buildCollateralCowProviderExtraData()
    : undefined
  await requestCollateralQuotesNow({
    tokenIn: sourceCollateralEVault.value.asset.address as Address,
    tokenOut: targetCollateralVault.value.asset.address as Address,
    accountIn: subAccount.value,
    accountOut: subAccount.value,
    amount: currentCollateralAssets.value,
    vaultIn: sourceCollateralEVault.value.address as Address,
    receiver: targetCollateralVault.value.address as Address,
    slippage: slippage.value,
    swapperMode: SwapperMode.EXACT_IN,
    isRepay: false,
    targetDebt: 0n,
    currentDebt: 0n,
    providerExtraData,
  })
}, 500)

const requestDebtQuotes = useDebounceFn(async () => {
  if (!debtNeedsSwap.value || !sourceDebtVault.value || !targetDebtVault.value || currentDebt.value <= 0n) {
    resetDebtQuotes()
    return
  }
  await requestDebtQuotesNow({
    tokenIn: targetDebtVault.value.asset.address as Address,
    tokenOut: sourceDebtVault.value.asset.address as Address,
    accountIn: subAccount.value,
    accountOut: subAccount.value,
    amount: currentDebt.value,
    vaultIn: targetDebtVault.value.address as Address,
    receiver: sourceDebtVault.value.address as Address,
    slippage: slippage.value,
    swapperMode: SwapperMode.TARGET_DEBT,
    isRepay: true,
    targetDebt: 0n,
    currentDebt: currentDebt.value,
  })
}, 500)

const onRefreshCollateralQuotes = () => {
  resetCollateralQuotes()
  void requestCollateralQuotes()
}
const onRefreshDebtQuotes = () => {
  resetDebtQuotes()
  void requestDebtQuotes()
}

const collateralRouteItems = computed(() => {
  const vault = targetCollateralVault.value
  if (!vault) return []
  return buildSwapRouteItems({
    quoteCards: collateralQuoteCardsSorted.value,
    getQuoteDiffPct: getCollateralQuoteDiffPct,
    decimals: Number(vault.asset.decimals),
    symbol: vault.asset.symbol,
    formatAmount: formatSmartAmount,
    amountField: 'amountOut',
    compare: 'max',
    diffPrefix: '-',
  })
})
const debtRouteItems = computed(() => {
  const vault = targetDebtVault.value
  if (!vault) return []
  return buildSwapRouteItems({
    quoteCards: debtQuoteCardsSorted.value,
    getQuoteDiffPct: getDebtQuoteDiffPct,
    decimals: Number(vault.asset.decimals),
    symbol: vault.asset.symbol,
    formatAmount: formatSmartAmount,
    amountField: 'amountIn',
    compare: 'min',
    diffPrefix: '+',
  })
})
const swapRouteEmptyMessage = 'Enter amount to fetch quotes'

const fromSupplyApy = computed(() => {
  const vault = sourceCollateralVault.value
  if (!vault) return null
  const base = getVaultSupplyApy(vault)
  return withVaultIntrinsicApy(base, vault, enableIntrinsicApy.value) + getSupplyRewardApy(vault.address)
})
const fromBorrowApy = computed(() => {
  if (!sourceDebtVault.value) return null
  const base = getVaultBorrowApy(sourceDebtVault.value)
  return withVaultIntrinsicApy(base, sourceDebtVault.value, enableIntrinsicApy.value)
    - getBorrowRewardApy(sourceDebtVault.value.address, sourceCollateralVault.value?.address)
})
const toBorrowApy = computed(() => {
  if (!effectiveDebtVault.value) return null
  const base = getVaultBorrowApy(effectiveDebtVault.value)
  return withVaultIntrinsicApy(base, effectiveDebtVault.value, enableIntrinsicApy.value)
    - getBorrowRewardApy(effectiveDebtVault.value.address, effectiveCollateralVault.value?.address)
})

const effectiveDebtProduct = useEulerProductOfVault(computed(() => effectiveDebtVault.value?.address || ''))
const effectiveCollateralProduct = useEulerProductOfVault(computed(() => effectiveCollateralVault.value?.address || ''))

type RefinanceCollateralVault = EVault | SecuritizeCollateralVault

interface RefinanceCollateralLeg {
  vault: RefinanceCollateralVault
  amount: bigint
}

interface CollateralPortfolioValue {
  valueUsd: number
  supplyApy: number | null
}

interface RefinanceRiskMetrics {
  ltv: number
  health: number
  liquidationLtv: number
  borrowLtv: number
}

const isRefinanceCollateralVault = (vault?: VaultEntity): vault is RefinanceCollateralVault =>
  !!vault && 'address' in vault && 'asset' in vault && 'shares' in vault

const nextCollateralAmountNano = computed<bigint | null>(() => {
  if (!effectiveCollateralVault.value) return null
  if (!hasCollateralChange.value) return currentCollateralAssets.value
  if (!targetCollateralVault.value) return null
  if (isSameCollateralAsset.value) return currentCollateralAssets.value
  if (!collateralQuote.value) return null
  return BigInt(collateralQuote.value.amountOut || 0)
})

const currentCollateralLegs = computed<RefinanceCollateralLeg[]>(() =>
  (position.value?.collaterals ?? [])
    .filter(collateral => isRefinanceCollateralVault(collateral.vault) && collateral.assets > 0n)
    .map(collateral => ({
      vault: collateral.vault as RefinanceCollateralVault,
      amount: collateral.assets,
    })),
)

const nextCollateralLegs = computed<RefinanceCollateralLeg[]>(() => {
  if (!hasCollateralChange.value) return currentCollateralLegs.value

  const target = targetCollateralVault.value
  const targetAmount = nextCollateralAmountNano.value
  const sourceAddress = normalizeVaultAddress(sourceCollateralVault.value?.address)
  const legs: RefinanceCollateralLeg[] = []
  let replacedSource = false

  for (const leg of currentCollateralLegs.value) {
    if (sourceAddress && normalizeVaultAddress(leg.vault.address) === sourceAddress) {
      replacedSource = true
      if (target && targetAmount !== null && targetAmount > 0n) {
        legs.push({ vault: target, amount: targetAmount })
      }
      continue
    }

    legs.push(leg)
  }

  if (!replacedSource && target && targetAmount !== null && targetAmount > 0n) {
    legs.push({ vault: target, amount: targetAmount })
  }

  return legs
})

const nextDebtAmountNano = computed<bigint | null>(() => {
  if (!effectiveDebtVault.value) return null
  if (!hasDebtChange.value) return currentDebt.value
  if (!targetDebtVault.value) return null
  if (isSameDebtAsset.value) return currentDebt.value
  if (!debtQuote.value) return null
  return BigInt(debtQuote.value.amountIn || 0)
})

const areRoeLegsApplicable = (legs: readonly RefinanceCollateralLeg[], debtVault: EVault | undefined) =>
  areRoeCollateralVaultsCorrelatedWithBorrow(legs.map(({ vault }) => vault), debtVault, getTokenCategoryTags)
const isCurrentRoeApplicable = computed(() =>
  areRoeLegsApplicable(currentCollateralLegs.value, sourceDebtVault.value),
)
const isNextRoeApplicable = computed(() =>
  areRoeLegsApplicable(nextCollateralLegs.value, effectiveDebtVault.value),
)

const getSupplyApyForVault = (vault: RefinanceCollateralVault) =>
  withVaultIntrinsicApy(getVaultSupplyApy(vault), vault, enableIntrinsicApy.value) + getSupplyRewardApy(vault.address)

const getCollateralPortfolioValue = async (legs: RefinanceCollateralLeg[]): Promise<CollateralPortfolioValue | null> => {
  if (!legs.length) return null

  let valueUsd = 0
  let weightedSupplyApy = 0
  for (const leg of legs) {
    const legValue = await getAssetUsdValue(leg.amount, leg.vault, 'off-chain')
    if (legValue === undefined || legValue === null) return null
    valueUsd += legValue
    weightedSupplyApy += legValue * getSupplyApyForVault(leg.vault)
  }

  return {
    valueUsd,
    supplyApy: valueUsd > 0 ? weightedSupplyApy / valueUsd : null,
  }
}

const currentSupplyPortfolioValue = ref<CollateralPortfolioValue | null>(null)
watchEffect(async () => {
  currentSupplyPortfolioValue.value = await getCollateralPortfolioValue(currentCollateralLegs.value)
})
const currentBorrowValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!sourceDebtVault.value) {
    currentBorrowValueUsd.value = null
    return
  }
  currentBorrowValueUsd.value = (await getAssetUsdValue(currentDebt.value, sourceDebtVault.value, 'off-chain')) ?? null
})
const nextSupplyPortfolioValue = ref<CollateralPortfolioValue | null>(null)
watchEffect(async () => {
  nextSupplyPortfolioValue.value = await getCollateralPortfolioValue(nextCollateralLegs.value)
})
const nextBorrowValueUsd = ref<number | null>(null)
watchEffect(async () => {
  const vault = effectiveDebtVault.value
  const amount = nextDebtAmountNano.value
  if (!vault || amount === null) {
    nextBorrowValueUsd.value = null
    return
  }
  nextBorrowValueUsd.value = (await getAssetUsdValue(amount, vault, 'off-chain')) ?? null
})

const roeBefore = computed(() => {
  if (!isCurrentRoeApplicable.value) return null
  return position.value?.roe
    ?? calculateRoe(currentSupplyPortfolioValue.value?.valueUsd ?? null, currentBorrowValueUsd.value, currentSupplyPortfolioValue.value?.supplyApy ?? null, fromBorrowApy.value)
})
const roeAfter = computed(() => {
  if (!isNextRoeApplicable.value) return null
  if (!hasAnyChange.value && position.value?.roe !== undefined && isCurrentRoeApplicable.value) return position.value.roe
  return calculateRoe(nextSupplyPortfolioValue.value?.valueUsd ?? null, nextBorrowValueUsd.value, nextSupplyPortfolioValue.value?.supplyApy ?? null, toBorrowApy.value)
})

const currentLtv = computed(() => {
  const ltv = position.value?.userLTV ?? position.value?.currentLTV
  return ltv === undefined ? null : ltvToPercent(nanoToValue(ltv, 18))
})
const currentHealth = computed(() => {
  const health = position.value?.healthFactor
  return health === undefined ? null : nanoToValue(health, 18)
})
const currentPriceRatio = computed(() => {
  if (!sourceCollateralVault.value || !sourceDebtVault.value) return null
  const collateralPrice = getCollateralOraclePrice(sourceDebtVault.value, sourceCollateralVault.value)
  const borrowPrice = getAssetOraclePrice(sourceDebtVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
const nextPriceRatio = computed(() => {
  if (!effectiveCollateralVault.value || !effectiveDebtVault.value) return null
  const collateralPrice = getCollateralOraclePrice(effectiveDebtVault.value, effectiveCollateralVault.value)
  const borrowPrice = getAssetOraclePrice(effectiveDebtVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
const nextDebtAmount = computed(() => {
  if (!effectiveDebtVault.value || nextDebtAmountNano.value === null) return null
  return nanoToValue(nextDebtAmountNano.value, effectiveDebtVault.value.shares.decimals)
})
const getRiskMetrics = (
  debtVault: EVault | undefined,
  collateralLegs: RefinanceCollateralLeg[],
  debtAmount: number | null,
): RefinanceRiskMetrics | null => {
  if (!debtVault || debtAmount === null) return null
  if (debtAmount <= 0) {
    return {
      ltv: 0,
      health: Infinity,
      liquidationLtv: Infinity,
      borrowLtv: Infinity,
    }
  }

  let totalCollateralValue = 0
  let borrowCapacity = 0
  let liquidationCapacity = 0
  for (const leg of collateralLegs) {
    if (leg.amount <= 0n) continue
    const match = debtVault.collaterals.find(
      ltv => normalizeVaultAddress(ltv.address) === normalizeVaultAddress(leg.vault.address),
    )
    if (!match) continue

    const priceRatio = conservativePriceRatioNumber(
      getCollateralOraclePrice(debtVault, leg.vault),
      getAssetOraclePrice(debtVault),
    )
    if (priceRatio === null || priceRatio <= 0) return null

    const amount = nanoToValue(leg.amount, leg.vault.shares.decimals)
    const collateralValue = amount * priceRatio
    if (!Number.isFinite(collateralValue) || collateralValue <= 0) continue

    totalCollateralValue += collateralValue
    borrowCapacity += collateralValue * ltvToPercent(match.borrowLTV)
    liquidationCapacity += collateralValue * ltvToPercent(match.liquidationLTV)
  }

  if (totalCollateralValue <= 0) return null

  const ltv = (debtAmount / totalCollateralValue) * 100
  const liquidationLtv = liquidationCapacity / totalCollateralValue
  const borrowLtv = borrowCapacity / totalCollateralValue

  return {
    ltv,
    health: ltv > 0 ? liquidationLtv / ltv : Infinity,
    liquidationLtv,
    borrowLtv,
  }
}
const currentRiskMetrics = computed<RefinanceRiskMetrics | null>(() =>
  getRiskMetrics(sourceDebtVault.value, currentCollateralLegs.value, nanoToValue(currentDebt.value, sourceDebtVault.value?.shares.decimals ?? 18)),
)
const nextRiskMetrics = computed<RefinanceRiskMetrics | null>(() =>
  getRiskMetrics(effectiveDebtVault.value, nextCollateralLegs.value, nextDebtAmount.value),
)
const nextLtv = computed(() => nextRiskMetrics.value?.ltv ?? null)
const currentBorrowLtv = computed(() => currentRiskMetrics.value?.borrowLtv ?? null)
const nextBorrowLtv = computed(() => nextRiskMetrics.value?.borrowLtv ?? null)
const nextHealth = computed(() => nextRiskMetrics.value?.health ?? null)
const currentLiquidationPrice = computed(() => {
  if (!currentPriceRatio.value || !currentHealth.value) return null
  if (currentHealth.value < 1) return null
  return currentPriceRatio.value / currentHealth.value
})
const nextLiquidationPrice = computed(() => {
  if (!nextPriceRatio.value || !nextHealth.value) return null
  if (nextHealth.value < 1) return null
  return nextPriceRatio.value / nextHealth.value
})

const liqPriceInvert = usePriceInvert(
  () => effectiveCollateralVault.value?.asset.symbol,
  () => effectiveDebtVault.value?.asset.symbol,
)
const currentLiqDisplaySymbol = computed(() => {
  const collateral = sourceCollateralVault.value?.asset.symbol || ''
  const debt = sourceDebtVault.value?.asset.symbol || ''
  return liqPriceInvert.isInverted ? `${debt}/${collateral}` : `${collateral}/${debt}`
})

const pairCompatibilityError = computed(() => {
  if (!hasAnyChange.value || !effectiveDebtVault.value || !effectiveCollateralVault.value) return null
  return isDebtCollateralCompatible(effectiveDebtVault.value, effectiveCollateralVault.value)
    ? null
    : 'Selected debt vault does not accept the selected collateral'
})
const collateralCowDebtSwapError = computed(() =>
  isSelectedCollateralCowSwapProvider.value && hasDebtChange.value
    ? 'CoW can only be used to swap collateral. Choose a non-CoW route or remove the debt vault change.'
    : null,
)
const hasAllRequiredQuotes = computed(() =>
  (!collateralNeedsSwap.value || !!selectedCollateralQuote.value)
  && (!debtNeedsSwap.value || !!selectedDebtQuote.value),
)
const healthError = computed(() => {
  if (!hasAnyChange.value || !hasAllRequiredQuotes.value || nextHealth.value === null) return null
  if (!Number.isFinite(nextHealth.value)) return null
  return nextHealth.value <= 1 ? 'Refinance would make position unhealthy' : null
})
const borrowCapacityError = computed(() => {
  if (!hasAnyChange.value || !hasAllRequiredQuotes.value) return null
  if (!nextBorrowLtv.value || nextBorrowLtv.value <= 0) {
    return 'Selected debt vault does not accept the selected collateral'
  }
  return null
})
const refinanceGuardError = computed(() => collateralCowDebtSwapError.value || pairCompatibilityError.value || healthError.value)

watch(refinanceGuardError, (error) => {
  if (error) {
    registerOperationBlocker('refinance-validation', error)
  }
  else {
    unregisterOperationBlocker('refinance-validation')
  }
}, { immediate: true })

onUnmounted(() => {
  unregisterOperationBlocker('refinance-validation')
})

const plannedOps = computed<PlannedOp[]>(() => {
  const steps: PlannedOp[] = []
  if (hasCollateralChange.value && sourceCollateralEVault.value && targetCollateralVault.value) {
    steps.push({
      vault: sourceCollateralEVault.value,
      op: isSameCollateralAsset.value ? OP_REDEEM : OP_WITHDRAW,
    })
    steps.push({ vault: targetCollateralVault.value, op: OP_SKIM })
  }
  if (hasDebtChange.value && sourceDebtVault.value && targetDebtVault.value) {
    steps.push({ vault: targetDebtVault.value, op: OP_BORROW })
    if (isSameDebtAsset.value) {
      steps.push({ vault: sourceDebtVault.value, op: OP_SKIM })
      steps.push({ vault: sourceDebtVault.value, op: OP_REPAY_WITH_SHARES })
    }
    else {
      steps.push({ vault: sourceDebtVault.value, op: OP_REPAY })
    }
  }
  return steps
})
const hookWarning = computed(() => getPlanHookDisabledWarning(plannedOps.value))

const debtLiquidityError = computed(() => {
  const vault = targetDebtVault.value
  const amount = nextDebtAmountNano.value
  if (!hasDebtChange.value || !vault || amount === null) return null
  if (vault.availableLiquidity < amount) return 'Not enough liquidity in the target debt vault'
  if (vault.caps.borrowCap > 0n && vault.caps.borrowCap < maxUint256 && vault.totalBorrowed + amount > vault.caps.borrowCap) {
    return 'Borrow cap would be exceeded on the target debt vault'
  }
  return null
})
const collateralSupplyCapError = computed(() => {
  const vault = targetCollateralVault.value
  const amount = nextCollateralAmountNano.value
  if (!hasCollateralChange.value || !vault || amount === null) return null
  if (vault.caps.supplyCap > 0n && vault.caps.supplyCap < maxUint256 && vault.totalAssets + amount > vault.caps.supplyCap) {
    return 'Supply cap would be exceeded on the target collateral vault'
  }
  return null
})

const collateralPriceImpact = ref<number | null>(null)
watchEffect(async () => {
  if (!collateralNeedsSwap.value || !collateralQuote.value || !sourceCollateralEVault.value || !targetCollateralVault.value) {
    collateralPriceImpact.value = null
    return
  }
  const amountInUsd = await getAssetUsdValue(BigInt(collateralQuote.value.amountIn || 0), sourceCollateralEVault.value, 'off-chain')
  const amountOutUsd = await getAssetUsdValue(BigInt(collateralQuote.value.amountOut || 0), targetCollateralVault.value, 'off-chain')
  if (!amountInUsd || !amountOutUsd) {
    collateralPriceImpact.value = null
    return
  }
  const impact = (amountOutUsd / amountInUsd - 1) * 100
  collateralPriceImpact.value = Number.isFinite(impact) ? impact : null
})
const debtPriceImpact = ref<number | null>(null)
watchEffect(async () => {
  if (!debtNeedsSwap.value || !debtQuote.value || !sourceDebtVault.value || !targetDebtVault.value) {
    debtPriceImpact.value = null
    return
  }
  const oldDebtUsd = await getAssetUsdValue(BigInt(debtQuote.value.amountOut || 0), sourceDebtVault.value, 'off-chain')
  const newDebtUsd = await getAssetUsdValue(BigInt(debtQuote.value.amountIn || 0), targetDebtVault.value, 'off-chain')
  if (!oldDebtUsd || !newDebtUsd) {
    debtPriceImpact.value = null
    return
  }
  const impact = (newDebtUsd / oldDebtUsd - 1) * 100
  debtPriceImpact.value = Number.isFinite(impact) ? impact : null
})
const directPriceImpact = computed(() => {
  const impacts = [collateralPriceImpact.value, debtPriceImpact.value]
    .filter((value): value is number => value !== null)
  if (!impacts.length) return null
  return Math.min(...impacts)
})
const shouldGateUnknownPriceImpact = computed(() =>
  (collateralNeedsSwap.value && !!selectedCollateralQuote.value && collateralPriceImpact.value === null)
  || (debtNeedsSwap.value && !!selectedDebtQuote.value && debtPriceImpact.value === null),
)
const { guardWithPriceImpact } = usePriceImpactGate({
  directPriceImpact,
  shouldGateUnknown: shouldGateUnknownPriceImpact,
})

const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(...getOperationVaultAddresses()))
const validationError = computed(() => {
  if (!hasAnyChange.value) return 'Choose a new collateral vault, debt vault, or both'
  if (collateralMigrationDisabledReason.value && targetCollateralVault.value) return collateralMigrationDisabledReason.value
  if (hookWarning.value) return hookWarning.value.message
  if (collateralCowDebtSwapError.value) return collateralCowDebtSwapError.value
  if (debtLiquidityError.value) return debtLiquidityError.value
  if (collateralSupplyCapError.value) return collateralSupplyCapError.value
  if (pairCompatibilityError.value) return pairCompatibilityError.value
  if (borrowCapacityError.value) return borrowCapacityError.value
  if (healthError.value) return healthError.value
  return null
})
const isSubmitDisabled = computed(() => {
  if (!isConnected.value) return false
  if (isLoading.value || isSubmitting.value) return true
  if (validationError.value) return true
  if (!hasAllRequiredQuotes.value) return true
  return !!simulationError.value
})
const isReviewButtonDisabled = computed(() => isSubmitDisabled.value || isPreparing.value)
const reviewRefinanceDisabled = computed(() => isGeoBlocked.value || isReviewButtonDisabled.value)
const reviewRefinanceLabel = computed(() => {
  if (!hasAnyChange.value) return 'Choose Vaults'
  if (!hasAllRequiredQuotes.value) return 'Select Quotes'
  return 'Review Refinance'
})
const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (validationError.value) return { message: validationError.value, variant: validationError.value === healthError.value ? 'error' : 'warning' }
  if (collateralQuoteError.value && collateralNeedsSwap.value) return { message: collateralQuoteError.value, variant: 'warning' }
  if (debtQuoteError.value && debtNeedsSwap.value) return { message: debtQuoteError.value, variant: 'warning' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  if (collateralNeedsSwap.value && isCollateralQuoteLoading.value) return { message: 'Fetching collateral swap quotes...', variant: 'warning' }
  if (debtNeedsSwap.value && isDebtQuoteLoading.value) return { message: 'Fetching debt swap quotes...', variant: 'warning' }
  if (collateralNeedsSwap.value && !selectedCollateralQuote.value) return { message: 'Select a collateral swap quote to continue', variant: 'warning' }
  if (debtNeedsSwap.value && !selectedDebtQuote.value) return { message: 'Select a debt swap quote to continue', variant: 'warning' }
  return undefined
})

const debtDisplayAmount = computed({
  get: () => formatVaultAmount(nextDebtAmountNano.value ?? currentDebt.value, effectiveDebtVault.value),
  set: () => {},
})
const collateralDisplayAmount = computed({
  get: () => formatVaultAmount(nextCollateralAmountNano.value ?? currentCollateralAssets.value, effectiveCollateralVault.value),
  set: () => {},
})

const collateralSwapSummary = computed(() =>
  collateralQuote.value && sourceCollateralEVault.value && targetCollateralVault.value
    ? buildQuoteSummary(collateralQuote.value, sourceCollateralEVault.value, targetCollateralVault.value, 'amountIn', 'amountOut')
    : null,
)
const debtSwapSummary = computed(() =>
  debtQuote.value && sourceDebtVault.value && targetDebtVault.value
    ? buildQuoteSummary(debtQuote.value, targetDebtVault.value, sourceDebtVault.value, 'amountIn', 'amountOut')
    : null,
)
const collateralRoutedVia = computed(() => getRoutedVia(collateralSelectedProvider.value, collateralQuote.value))
const debtRoutedVia = computed(() => getRoutedVia(debtSelectedProvider.value, debtQuote.value))
const effectiveQuoteFetchedAt = computed(() => {
  const fetched = [
    collateralNeedsSwap.value ? collateralQuoteFetchedAt.value : null,
    debtNeedsSwap.value ? debtQuoteFetchedAt.value : null,
  ].filter((value): value is number => typeof value === 'number')
  return fetched.length ? Math.min(...fetched) : null
})

const targetDebtVaultAddress = computed(() => typeof route.query.to === 'string' ? normalizeVaultAddress(route.query.to) : '')
watch([debtTargetVaults, targetDebtVaultAddress], ([vaults, targetAddress]) => {
  if (!targetAddress || targetDebtVault.value) return
  const vault = vaults.find(candidate => normalizeVaultAddress(candidate.address) === targetAddress)
  if (vault) targetDebtVault.value = vault
}, { immediate: true })

watch(debtTargetVaults, (vaults) => {
  if (!targetDebtVault.value) return
  const exists = vaults.some(vault => normalizeVaultAddress(vault.address) === normalizeVaultAddress(targetDebtVault.value?.address))
  if (!exists) targetDebtVault.value = undefined
})
watch(collateralTargetVaults, (vaults) => {
  if (!targetCollateralVault.value) return
  const exists = vaults.some(vault => normalizeVaultAddress(vault.address) === normalizeVaultAddress(targetCollateralVault.value?.address))
  if (!exists) targetCollateralVault.value = undefined
})
watch([targetCollateralVault, () => slippage.value, currentCollateralAssets], () => {
  clearSimulationError()
  resetCollateralQuotes()
  void requestCollateralQuotes()
})
watch([targetDebtVault, () => slippage.value, currentDebt], () => {
  clearSimulationError()
  resetDebtQuotes()
  void requestDebtQuotes()
})
watch([selectedCollateralQuote, selectedDebtQuote], () => {
  clearSimulationError()
})
watch(
  [sourceDebtVault, sourceCollateralVault, targetDebtVault, targetCollateralVault],
  ([sourceDebt, sourceCollateral, targetDebt, targetCollateral]) => {
    const tokens: Address[] = []
    const seen = new Set<string>()
    const push = (addr?: string) => {
      if (!addr) return
      const key = addr.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      tokens.push(addr as Address)
    }
    push(sourceDebt?.asset.address)
    push(sourceCollateral?.asset.address)
    push(targetDebt?.asset.address)
    push(targetCollateral?.asset.address)
    if (tokens.length) void primeSlotHintsFor(tokens)
  },
  { immediate: true },
)

const loadPosition = async () => {
  if (!isConnected.value && !isSpyMode.value) {
    position.value = null
    return
  }
  isLoading.value = true
  await until(isPositionsLoaded).toBe(true)
  position.value = getPositionBySubAccountIndex(+positionIndex) || null
  isLoading.value = false
}

watch([isPositionsLoaded, () => route.params.number], ([loaded]) => {
  if (loaded) void loadPosition()
}, { immediate: true })

const onDebtVaultChange = (selectedIndex: number) => {
  clearSimulationError()
  const selected = debtSelectionVaults.value[selectedIndex]
  if (!selected || !sourceDebtVault.value) return
  if (normalizeVaultAddress(selected.address) === normalizeVaultAddress(sourceDebtVault.value.address)) {
    targetDebtVault.value = undefined
    return
  }
  targetDebtVault.value = selected as EVault
}

const onCollateralVaultChange = (selectedIndex: number) => {
  clearSimulationError()
  const selected = collateralSelectionVaults.value[selectedIndex]
  if (!selected || !sourceCollateralVault.value) return
  if (normalizeVaultAddress(selected.address) === normalizeVaultAddress(sourceCollateralVault.value.address)) {
    targetCollateralVault.value = undefined
    return
  }
  if (!isSecuritizeCollateralVault(selected)) {
    targetCollateralVault.value = selected as EVault
  }
}

const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

const submitCowSwapCollateralSwap = async () => {
  if (!sourceCollateralEVault.value || !targetCollateralVault.value || !selectedCollateralQuote.value || !address.value) return
  if (validationError.value) return

  cowSwapExecution.reset()

  const chainId = currentChainId.value ?? 0
  const chainConfig = getCowSwapChainConfig(chainId)
  if (!chainConfig) {
    showError('CoW is not available on this network')
    return
  }

  if (currentCollateralShares.value <= 0n) {
    showError('Collateral share balance is unavailable')
    return
  }

  const orderAmounts = getCowSwapQuoteOrderAmounts(selectedCollateralQuote.value, {
    slippage: slippage.value,
    slippageTarget: 'buyAmount',
  })
  if (!orderAmounts) {
    showError('Invalid CoW quote: missing order amounts')
    return
  }
  const { sellAmount, buyAmount } = orderAmounts

  const sdkAccount = planAccount.value
  if (!sdkAccount) {
    showError('Account not ready')
    return
  }

  const validTo = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
  const cowParams: CowSwapCollateralSwapExecuteParams = {
    chainId,
    account: sdkAccount,
    swapQuote: selectedCollateralQuote.value,
    slippage: slippage.value,
    validTo,
    disableSourceCollateral: true,
  }

  let currentAllowance = 0n
  try {
    const client = rpcClient.value
    if (client) {
      currentAllowance = await client.readContract({
        address: sourceCollateralEVault.value.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address.value as Address, chainConfig.vaultRelayer],
      }) as bigint
    }
  }
  catch {
    // Default to showing the approval step.
  }

  const fromVault = sourceCollateralEVault.value
  const toVault = targetCollateralVault.value
  const fromAsset = fromVault.asset
  const toAsset = toVault.asset
  const fromShareAmount = trimTrailingZeros(formatUnits(sellAmount, Number(fromAsset.decimals)))
  const fromAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(fromVault, sellAmount), Number(fromAsset.decimals)))
  const toAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(toVault, buyAmount), Number(toAsset.decimals)))

  const signSteps: DisplayStep[] = []
  let signIdx = 1
  const approval = buildApprovalSignSteps({
    chainId,
    tokenAddress: fromVault.address as Address,
    currentAllowance,
    requiredAmount: sellAmount,
    label: 'Approve for swap',
    assetInfo: {
      symbol: fromAsset.symbol,
      address: fromVault.address,
      iconAddress: fromAsset.address,
      amount: fromShareAmount,
    },
    startIndex: signIdx,
  })
  signSteps.push(...approval.steps)
  signIdx = approval.nextIndex
  signSteps.push({ index: signIdx++, label: 'Sign EVC permit', isSeparateTx: false })
  signSteps.push({ index: signIdx++, label: 'Sign CoW order', isSeparateTx: false })

  let wrapperIdx = 1
  const wrapperSteps: DisplayStep[] = [
    { index: wrapperIdx++, label: 'Enable collateral', labelSuffix: toAsset.symbol, isSeparateTx: false },
    { index: wrapperIdx++, label: 'Disable source collateral', labelSuffix: fromAsset.symbol, isSeparateTx: false },
    {
      index: wrapperIdx++,
      label: 'Transfer to wallet',
      isSeparateTx: false,
      assetInfo: {
        symbol: fromAsset.symbol,
        address: fromVault.address,
        iconAddress: fromAsset.address,
        amount: fromShareAmount,
      },
    },
    {
      index: wrapperIdx++,
      label: 'Swap',
      isSeparateTx: false,
      assetInfo: { symbol: fromAsset.symbol, address: fromAsset.address, amount: fromAssetAmount },
      toAssetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetAmount },
    },
    {
      index: wrapperIdx++,
      label: 'Verify min received',
      isSeparateTx: false,
      assetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetAmount },
    },
  ]

  const walletWarningsDescription
    = 'The CoW order and transfer steps use vault-share amounts. Swap and received amounts are shown in underlying assets. '
      + 'The CoW order receiver is your sub-account, not your main wallet - your wallet may flag this as a mismatch. '
      + 'You can verify the first 19 bytes (38 hex chars after "0x") of the receiver match your wallet address.'

  openCowSwapReviewModal(modal, {
    signSteps,
    wrapperSteps,
    walletWarningsDescription,
    execution: cowSwapExecution,
    orderStatus: cowSwapOrderStatus,
    executeParams: cowParams,
    quoteFetchedAt: collateralQuoteFetchedAt.value,
    logPrefix: 'refinance/collateral-cowswap',
  })
}

watch(() => cowSwapOrderStatus.orderStatus.value, (status) => {
  if (!status?.terminal) return
  if (status.type === 'traded' || status.type === 'fulfilled') {
    refreshAllPositions(undefined, address.value || '')
    modal.close()
    setTimeout(() => {
      router.replace({ path: '/portfolio', query: { network: route.query.network } })
      cowSwapExecution.reset()
    }, 400)
  }
})

const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value || isGeoBlocked.value || isSubmitDisabled.value) return
  isPreparing.value = true
  try {
    await guardWithPriceImpact(async () => {
      if (isSubmitDisabled.value || !sourceDebtVault.value) return

      if (isSelectedCollateralCowSwapProvider.value) {
        await submitCowSwapCollateralSwap()
        return
      }

      preparedPlan.value = null
      plan.value = null
      try {
        plan.value = await buildRefinancePlan()
        preparedPlan.value = await prepareTransactionPlan(plan.value, { account: currentPlanAccount() })
      }
      catch (e) {
        logWarn('refinance/buildPlan', e)
        showError('Failed to build transaction')
        return
      }

      const ok = preparedPlan.value
        ? await runPreparedSimulation(preparedPlan.value, buildRefinanceStateOverrideOptions())
        : await runSimulation(plan.value, buildRefinanceStateOverrideOptions())
      if (!ok) return

      modal.open(OperationReviewModal, {
        props: {
          type: 'refinance',
          asset: sourceDebtVault.value.asset,
          amount: formatVaultAmount(currentDebt.value, sourceDebtVault.value),
          plan: preparedPlan.value ? undefined : plan.value,
          prepared: preparedPlan.value || undefined,
          quoteFetchedAt: effectiveQuoteFetchedAt.value,
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

const send = async () => {
  isSubmitting.value = true
  try {
    if (preparedPlan.value) {
      await executePreparedPlan(preparedPlan.value)
    }
    else {
      const txPlan = await buildRefinancePlan()
      await executePlan(txPlan)
    }
    modal.close()
    setTimeout(() => {
      router.replace({ path: '/portfolio', query: { network: route.query.network } })
    }, 400)
  }
  catch (e) {
    showError('Transaction failed')
    logWarn('refinance/send', e)
  }
  finally {
    isSubmitting.value = false
  }
}

function normalizeVaultAddress(addr?: string): string {
  if (!addr) return ''
  try {
    return getAddress(addr)
  }
  catch {
    return ''
  }
}

function isDebtCollateralCompatible(
  debtVault: EVault,
  collateralVault: EVault | SecuritizeCollateralVault,
): boolean {
  const collateralAddress = normalizeVaultAddress(collateralVault.address)
  return debtVault.collaterals.some(
    ltv => normalizeVaultAddress(ltv.address) === collateralAddress && ltv.borrowLTV > 0,
  )
}

function makeVaultOption(
  vault: EVault | SecuritizeCollateralVault,
  apy: number | undefined,
  label: string,
): CollateralOption {
  return {
    type: 'vault',
    amount: 0,
    price: 0,
    apy,
    symbol: vault.asset.symbol,
    assetAddress: vault.asset.address,
    vaultAddress: vault.address,
    label: getVaultProductName(vault.address) || label,
    disabled: false,
    showBalance: false,
    vault,
  }
}

function formatVaultAmount(amount: bigint | null | undefined, vault?: EVault | SecuritizeCollateralVault): string {
  if (amount === null || amount === undefined || !vault) return ''
  return trimTrailingZeros(formatUnits(amount, Number(vault.asset.decimals)))
}

function convertVaultSharesToAssets(vault: EVault, sharesAmount: bigint): bigint {
  if (sharesAmount <= 0n) return 0n
  if (vault.totalShares <= 0n) return sharesAmount
  return (sharesAmount * vault.totalAssets) / vault.totalShares
}

function buildQuoteSummary(
  quote: SwapQuote,
  inputVault: EVault,
  outputVault: EVault,
  inputField: 'amountIn' | 'amountOut',
  outputField: 'amountIn' | 'amountOut',
) {
  const input = formatUnits(getQuoteAmount(quote, inputField), Number(inputVault.asset.decimals))
  const output = formatUnits(getQuoteAmount(quote, outputField), Number(outputVault.asset.decimals))
  return {
    from: `${formatSmartAmount(input)} ${inputVault.asset.symbol}`,
    to: `${formatSmartAmount(output)} ${outputVault.asset.symbol}`,
    fromExact: `${input} ${inputVault.asset.symbol}`,
    toExact: `${output} ${outputVault.asset.symbol}`,
  }
}

function getRoutedVia(provider: string | null, quote: SwapQuote | null): string | null {
  if (!provider) return quote ? 'Not selected' : null
  if (!quote?.route?.length) return provider
  return quote.route.map(route => route.providerName).join(', ')
}

function getOperationVaultAddresses(): string[] {
  const addresses: Array<string | undefined> = [
    sourceDebtVault.value?.address,
    sourceCollateralVault.value?.address,
    targetDebtVault.value?.address,
    targetCollateralVault.value?.address,
  ]
  return addresses.filter((value): value is string => !!value)
}
</script>

<template>
  <div class="relative flex gap-32">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="`/position/${positionIndex}`"
    />
    <VaultForm
      back
      :back-fallback="`/position/${positionIndex}`"
      title="Refinance"
      description="Move debt, collateral, or both to new vaults in one transaction."
      class="flex flex-col gap-16 w-full"
      :loading="isLoading || isPositionsLoading"
      @submit.prevent="submit"
    >
      <template v-if="sourceDebtVault && sourceCollateralVault && effectiveDebtVault && effectiveCollateralVault">
        <VaultLabelsAndAssets
          :vault="sourceDebtVault"
          :assets="[sourceCollateralVault.asset, sourceDebtVault.asset]"
          :assets-label="pairAssetsLabel"
          size="large"
        />
        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-model="collateralDisplayAmount"
              :desc="effectiveCollateralProduct.name"
              label="Collateral vault"
              :asset="effectiveCollateralVault.asset"
              :vault="effectiveCollateralVault"
              :balance="currentCollateralAssets"
              :collateral-options="collateralSelectionOptions"
              collateral-modal-title="Select collateral vault"
              collateral-modal-apy-label="Supply APY"
              selected-source="vault"
              :selected-vault-address="effectiveCollateralVault.address"
              :readonly="true"
              @change-collateral="onCollateralVaultChange"
            />

            <UiAlert
              v-if="collateralMigrationDisabledReason"
              title="Collateral migration unavailable"
              :description="collateralMigrationDisabledReason"
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-else-if="canChangeCollateral && !collateralTargetVaults.length && !isLoading && !isPositionsLoading"
              title="No collateral options"
              description="There are no target collateral vaults available for the selected debt vault."
              variant="warning"
              size="compact"
            />

            <SwapRouteSelector
              v-if="targetCollateralVault && collateralNeedsSwap"
              title="Select collateral swap route"
              :items="collateralRouteItems"
              :selected-provider="collateralSelectedProvider"
              :status-label="collateralQuotesStatusLabel"
              :is-loading="isCollateralQuoteLoading"
              :empty-message="swapRouteEmptyMessage"
              @select="selectCollateralProvider"
              @refresh="onRefreshCollateralQuotes"
            />

            <AssetInput
              v-model="debtDisplayAmount"
              :desc="effectiveDebtProduct.name"
              label="Debt vault"
              :asset="effectiveDebtVault.asset"
              :vault="effectiveDebtVault"
              :balance="currentDebt"
              :collateral-options="debtSelectionOptions"
              collateral-modal-title="Select debt vault"
              collateral-modal-apy-label="Borrow APY"
              selected-source="vault"
              :selected-vault-address="effectiveDebtVault.address"
              :readonly="true"
              @change-collateral="onDebtVaultChange"
            />

            <UiAlert
              v-if="!debtTargetVaults.length && !isLoading && !isPositionsLoading"
              title="No debt options"
              description="There are no other debt vaults available for the selected collateral vault."
              variant="warning"
              size="compact"
            />

            <SwapRouteSelector
              v-if="targetDebtVault && debtNeedsSwap"
              title="Select debt swap route"
              :items="debtRouteItems"
              :selected-provider="debtSelectedProvider"
              :status-label="debtQuotesStatusLabel"
              :is-loading="isDebtQuoteLoading"
              :empty-message="swapRouteEmptyMessage"
              @select="selectDebtProvider"
              @refresh="onRefreshDebtQuotes"
            />

            <UiAlert
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-if="validationError"
              title="Refinance"
              :description="validationError"
              :variant="validationError === healthError ? 'error' : 'warning'"
              size="compact"
            />
            <UiAlert
              v-if="collateralQuoteError && collateralNeedsSwap"
              title="Collateral swap quote"
              variant="warning"
              :description="collateralQuoteError"
              size="compact"
            />
            <UiAlert
              v-if="debtQuoteError && debtNeedsSwap"
              title="Debt swap quote"
              variant="warning"
              :description="debtQuoteError"
              size="compact"
            />
            <UiAlert
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
              <VaultFormSubmit
                :disabled="reviewRefinanceDisabled"
                :loading="isSubmitting || isPreparing"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
              >
                {{ reviewRefinanceLabel }}
              </VaultFormSubmit>
            </div>
          </div>

          <VaultFormInfoBlock
            :loading="(collateralNeedsSwap && isCollateralQuoteLoading) || (debtNeedsSwap && isDebtQuoteLoading)"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow label="ROE">
              <SummaryValue
                :before="roeBefore !== null ? formatNumber(roeBefore) : undefined"
                :after="roeAfter !== null && hasAllRequiredQuotes ? formatNumber(roeAfter) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow
              label="Liq. price"
              align-top
            >
              <p class="text-p2 text-right inline-flex items-center flex-wrap justify-end gap-x-4">
                <template v-if="currentLiquidationPrice !== null && nextLiquidationPrice !== null && hasAllRequiredQuotes">
                  <span class="text-content-tertiary">{{ formatSmartAmount(liqPriceInvert.invertValue(currentLiquidationPrice)) }}<span class="text-p3 ml-2">{{ currentLiqDisplaySymbol }}</span></span>
                  &rarr; <span class="text-content-primary">{{ formatSmartAmount(liqPriceInvert.invertValue(nextLiquidationPrice)) }}<span class="text-content-tertiary text-p3 ml-2">{{ liqPriceInvert.displaySymbol }}</span></span>
                </template>
                <template v-else>
                  {{ liqPriceInvert.invertValue(currentLiquidationPrice) != null ? formatSmartAmount(liqPriceInvert.invertValue(currentLiquidationPrice)!) : '-' }}
                  <span
                    v-if="liqPriceInvert.invertValue(currentLiquidationPrice) != null"
                    class="text-content-tertiary text-p3"
                  >{{ currentLiqDisplaySymbol }}</span>
                </template>
                <button
                  type="button"
                  class="text-content-tertiary hover:text-content-primary transition-colors inline-flex"
                  @click.stop="liqPriceInvert.toggle"
                >
                  <SvgIcon
                    name="swap-horizontal"
                    class="!w-12 !h-12"
                  />
                </button>
              </p>
            </SummaryRow>
            <SummaryRow label="Liq. buffer">
              <SummaryValue
                :before="formatLiqBuffer(liqPriceInvert.invertValue(currentPriceRatio), liqPriceInvert.invertValue(currentLiquidationPrice))"
                :after="nextLiquidationPrice !== null && hasAllRequiredQuotes
                  ? formatLiqBuffer(liqPriceInvert.invertValue(nextPriceRatio), liqPriceInvert.invertValue(nextLiquidationPrice))
                  : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="LTV">
              <SummaryValue
                :before="currentLtv !== null ? formatNumber(currentLtv) : undefined"
                :after="nextLtv !== null && hasAllRequiredQuotes ? formatNumber(nextLtv) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="currentHealth !== null ? formatHealthScore(currentHealth) : undefined"
                :after="nextHealth !== null && hasAllRequiredQuotes ? formatHealthScore(nextHealth) : undefined"
              />
            </SummaryRow>
            <SummaryRow label="Borrow LTV">
              <SummaryValue
                :before="currentBorrowLtv !== null ? formatNumber(currentBorrowLtv) : undefined"
                :after="nextBorrowLtv !== null && hasAllRequiredQuotes && hasAnyChange ? formatNumber(nextBorrowLtv) : undefined"
                suffix="%"
              />
            </SummaryRow>

            <template v-if="collateralNeedsSwap && collateralSwapSummary">
              <SummaryRow label="Collateral swap">
                <p class="text-p2 text-right">
                  <UiExactAmount
                    :exact="`${collateralSwapSummary.fromExact} -> ${collateralSwapSummary.toExact}`"
                    align="end"
                  >
                    {{ collateralSwapSummary.from }} -> {{ collateralSwapSummary.to }}
                  </UiExactAmount>
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="collateralPriceImpact !== null"
                label="Collateral impact"
              >
                <p class="text-p2">
                  {{ formatNumber(collateralPriceImpact, 2, 2) }}%
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="collateralRoutedVia"
                label="Collateral route"
              >
                <p class="text-p2 text-right">
                  {{ collateralRoutedVia }}
                </p>
              </SummaryRow>
            </template>

            <template v-if="debtNeedsSwap && debtSwapSummary">
              <SummaryRow label="Debt swap">
                <p class="text-p2 text-right">
                  <UiExactAmount
                    :exact="`${debtSwapSummary.fromExact} -> ${debtSwapSummary.toExact}`"
                    align="end"
                  >
                    {{ debtSwapSummary.from }} -> {{ debtSwapSummary.to }}
                  </UiExactAmount>
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="debtPriceImpact !== null"
                label="Debt impact"
              >
                <p class="text-p2">
                  {{ formatNumber(debtPriceImpact, 2, 2) }}%
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="debtRoutedVia"
                label="Debt route"
              >
                <p class="text-p2 text-right">
                  {{ debtRoutedVia }}
                </p>
              </SummaryRow>
            </template>

            <SummaryRow
              v-if="collateralNeedsSwap || debtNeedsSwap"
              label="Slippage tolerance"
            >
              <button
                type="button"
                class="flex items-center gap-6 text-p2"
                @click="openSlippageSettings"
              >
                <span>{{ formatNumber(slippage, 2, 0) }}%</span>
                <SvgIcon
                  name="edit"
                  class="!w-16 !h-16 text-accent-600"
                />
              </button>
            </SummaryRow>
          </VaultFormInfoBlock>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
