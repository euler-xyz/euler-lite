<script setup lang="ts">
import { isEVault, isSecuritizeCollateralVault, SwapperMode, type SwapQuote, type EVault, type PortfolioBorrowPosition, type SecuritizeCollateralVault, type TransactionPlan, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { areRoeCollateralVaultsCorrelatedWithBorrow, resolvePositionRoeCollateralVaults } from '~/utils/position-roe'
import { getAssetUsdValue, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatioNumber, getCollateralUsdValueOrZero } from '~/utils/sdk-prices'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { formatNumber, formatSmartAmount, formatHealthScore, trimTrailingZeros } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer, calculateRoe } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import type { DisplayStep } from '~/utils/stepDecoding'
import { useModal } from '~/components/ui/composables/useModal'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import type { SwapQuotePlanContext } from '~/composables/useSwapQuotesParallel'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { erc20Abi, formatUnits, getAddress, maxUint256, zeroAddress, type Address } from 'viem'
import {
  COWSWAP_ORDER_DEADLINE_SECONDS,
  COWSWAP_PROVIDER_EXTRA_DATA,
  buildCollateralSwapQuoteAppData,
  getCowSwapChainConfig,
  getCowSwapQuoteOrderAmounts,
  isCowProvider,
} from '~/entities/cowswap'
import type { CowSwapCollateralSwapExecuteParams } from '~/composables/cowswap'
import { useCowSwapCollateralSwapExecution, useCowSwapOrderStatus, openCowSwapReviewModal, buildApprovalSignSteps } from '~/composables/cowswap'
import { logWarn } from '~/utils/errorHandling'

const route = useRoute()
const { isConnected, address } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const effectiveAddress = computed(() => isSpyMode.value ? spyAddress.value : address.value)
const { isPositionsLoaded, isPositionsLoading, getPositionBySubAccountIndex } = useEulerAccount()
const { planCollateralChange } = useEulerTx()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { getTokenCategoryTags } = useTokenList()
const { isReady: isVaultsReady } = useVaults()
const { getOrFetch } = useVaultRegistry()
const { isReady: isEulerAddressesReady, loadEulerConfig } = useEulerAddresses()
const { client: rpcClient } = useRpcClient()
const { entryCount: batchEntryCount } = useTxBatch()
const shouldIncludeCowSwapQuotes = computed(() => batchEntryCount.value === 0)

const positionIndex = usePositionIndex()

// ── Vaults & position ────────────────────────────────────────────────────
// Layer-aware: tracks the active batch layer's portfolio so the form reflects
// simulated collateral/debt (a one-shot ref would freeze at the real state).
const position = computed<PortfolioBorrowPosition<VaultEntity> | null>(() =>
  (!isConnected.value && !isSpyMode.value) ? null : (getPositionBySubAccountIndex(+positionIndex) || null),
)
const pairAssetsLabel = usePositionPairLabel(position)
const selectedCollateral = ref<EVault | SecuritizeCollateralVault | null>(null)
const selectedCollateralShares = ref(0n)
const selectedCollateralAssets = ref(0n)
const lastCollateralAddress = ref('')

const primaryCollateralVault = computed<EVault | SecuritizeCollateralVault | undefined>(() =>
  (position.value ? position.value.collateralVault : undefined) as EVault | SecuritizeCollateralVault | undefined,
)
const fromVault = computed<EVault | SecuritizeCollateralVault | undefined>(() =>
  (selectedCollateral.value || primaryCollateralVault.value) as EVault | SecuritizeCollateralVault | undefined,
)
const borrowVault = computed<EVault | undefined>(() => position.value ? position.value.borrowVault as EVault | undefined : undefined)
const toVault: Ref<EVault | undefined> = ref()
useOperationGuard(computed(() => [fromVault.value?.address, toVault.value?.address, borrowVault.value?.address].filter(Boolean)))

const isFromSecuritize = computed(() => !!fromVault.value && isSecuritizeCollateralVault(fromVault.value))
const fromVaultAsRegular = computed(() => {
  if (!fromVault.value || isFromSecuritize.value) return undefined
  return fromVault.value as EVault
})
const { collateralOptions, collateralVaults } = useSwapCollateralOptions({
  currentVault: fromVaultAsRegular,
  liabilityVault: computed(() => borrowVault.value as EVault | undefined),
})
const normalizeVaultAddress = (address?: string) => {
  if (!address) return ''
  try {
    return getAddress(address)
  }
  catch {
    return ''
  }
}
const swapTargetVaults = computed(() => {
  const fromAddress = normalizeVaultAddress(fromVault.value?.address)
  return collateralVaults.value.filter(vault => normalizeVaultAddress(vault.address) !== fromAddress)
})
const swapTargetVaultAddresses = computed(() => new Set(swapTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))))
const swapTargetOptions = computed(() => {
  return collateralOptions.value.filter((option) => {
    if (!option.vaultAddress) return false
    return swapTargetVaultAddresses.value.has(normalizeVaultAddress(option.vaultAddress))
  })
})

const balance = computed(() => selectedCollateralAssets.value)
const targetVaultAddress = computed(() => typeof route.query.to === 'string' ? route.query.to : '')

const isMaxSwap = computed(() => {
  if (!fromVault.value?.asset || !fromAmount.value) return false
  try {
    const amount = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
    return balance.value > 0n && amount >= balance.value
  }
  catch { return false }
})

// ── CowSwap collateral swap helpers ─────────────────────────────────────
// CoW orders sell vault SHARES (not underlying assets), because the wrapper
// transfers shares out of the position before the swap settles. Convert the
// user-typed asset amount to a share amount, ceiling-divided so the share
// amount covers the requested underlying.
const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  denominator > 0n ? (numerator + denominator - 1n) / denominator : 0n

const convertVaultSharesToAssets = (vault: EVault | SecuritizeCollateralVault, sharesAmount: bigint): bigint => {
  if (sharesAmount <= 0n) return 0n
  if (vault.totalShares <= 0n) return sharesAmount
  return (sharesAmount * vault.totalAssets) / vault.totalShares
}

const getSwapCollateralSharesAmountIn = (assetAmount: bigint): bigint => {
  if (assetAmount <= 0n) return 0n
  const shares = selectedCollateralShares.value
  const assets = selectedCollateralAssets.value
  if (isMaxSwap.value && shares > 0n) return shares
  if (shares <= 0n || assets <= 0n) return 0n
  if (assetAmount >= assets) return shares
  return ceilDiv(assetAmount * shares, assets)
}

const { chainId: currentChainId } = useEulerAddresses()
const { account: freshAccount } = useFreshAccount()
const { account: planAccount } = usePlanAccount()
const cowModal = useModal()
const cowSwapExecution = useCowSwapCollateralSwapExecution()
const cowSwapOrderStatus = useCowSwapOrderStatus(
  computed(() => cowSwapExecution.orderUid.value),
  currentChainId,
)

// ── Shared swap logic (must be before any code that uses its outputs) ────
const swap = useSwapPageLogic({
  amountField: 'amountOut',
  compare: 'max',
  includeCowSwap: () => shouldIncludeCowSwapQuotes.value,
  fromVault,
  toVault,
  balance,
  vaultOptions: swapTargetVaults,
  displayAmountField: 'amountOut',
  quoteDiffPrefix: '-',
  redirectPath: '/portfolio',
  targetVaultAddress,
  swapperMode: SwapperMode.EXACT_IN,
  getPlanAccount: () => planAccount.value,

  buildQuoteRequest(amount) {
    if (!fromVault.value || !toVault.value || !position.value) return null
    const account = (position.value.subAccount || effectiveAddress.value || zeroAddress) as Address
    // Per-provider CoW extras: SDK needs the shares-equivalent of the user's
    // asset input and the wrapper-encoded appData hash so the order can be
    // verified against the EVC permit by the wrapper contract.
    const swapCollateralSharesAmountIn = getSwapCollateralSharesAmountIn(amount)
    const quoteDeadline = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
    const chainConfig = getCowSwapChainConfig(currentChainId.value ?? 0)
    let providerExtraData
      = shouldIncludeCowSwapQuotes.value && swapCollateralSharesAmountIn > 0n
        ? COWSWAP_PROVIDER_EXTRA_DATA.collateralSwap(swapCollateralSharesAmountIn)
        : undefined
    if (providerExtraData && chainConfig) {
      providerExtraData = {
        ...providerExtraData,
        appData: buildCollateralSwapQuoteAppData(
          {
            owner: (effectiveAddress.value || zeroAddress) as Address,
            account,
            deadline: quoteDeadline,
            fromVault: fromVault.value.address as Address,
            toVault: toVault.value.address as Address,
            fromAmount: swapCollateralSharesAmountIn,
            disableSourceCollateral: isMaxSwap.value,
          },
          chainConfig.collateralSwapWrapper,
          Math.round(slippage.value * 100),
        ),
      }
    }
    return {
      params: {
        tokenIn: fromVault.value.asset.address as Address,
        tokenOut: toVault.value.asset.address as Address,
        accountIn: account,
        accountOut: account,
        amount,
        vaultIn: fromVault.value.address as Address,
        receiver: toVault.value.address as Address,
        slippage: slippage.value,
        swapperMode: SwapperMode.EXACT_IN,
        isRepay: false,
        targetDebt: 0n,
        currentDebt: 0n,
        providerExtraData,
      },
    }
  },

  async buildPlan(quote?: SwapQuote, context?: SwapQuotePlanContext): Promise<TransactionPlan> {
    if (!fromVault.value || !toVault.value || !position.value) throw new Error('Vaults or position not loaded')
    const swapQuote = quote ?? selectedQuote.value
    if (!isSameAsset.value && !swapQuote) throw new Error('No quote selected')
    const amount = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
    return planCollateralChange({
      fromVault: fromVault.value.address as Address,
      toVault: toVault.value.address as Address,
      amount,
      positionAccount: position.value.subAccount as Address,
      toAsset: toVault.value.asset.address as Address,
      isMax: isMaxSwap.value,
      enableCollateralTo: true,
      disableCollateralFrom: isMaxSwap.value,
      swapQuote: isSameAsset.value ? undefined : swapQuote!,
      swapperMode: SwapperMode.EXACT_IN,
      account: context?.account ?? planAccount.value,
    })
  },

  getBalanceError: amountNano => balance.value < amountNano ? 'Not enough balance' : null,

  getGeoBlockedAddresses() {
    const addresses: string[] = []
    if (fromVault.value) addresses.push(fromVault.value.address)
    if (borrowVault.value) addresses.push(borrowVault.value.address)
    return addresses
  },

  async computePriceImpact(q: SwapQuote) {
    if (!fromVault.value || !toVault.value || !borrowVault.value) return null
    const amountInUsd = await getCollateralValueUsdLocal(BigInt(q.amountIn))
    const amountOutUsd = await getAssetUsdValue(BigInt(q.amountOut), toVault.value, 'off-chain')
    if (!amountInUsd || !amountOutUsd) return null
    const impact = (amountOutUsd / amountInUsd - 1) * 100
    return Number.isFinite(impact) ? impact : null
  },
})

const {
  isLoading, isSubmitting, isPreparing, fromAmount, toAmount, slippage,
  isSameAsset, sameVaultError, errorText, quote,
  isGeoBlocked, reviewSwapDisabled, reviewSwapLabel, simulationError,
  isQuoteLoading, quoteError, quotesStatusLabel, selectedProvider, selectedQuote,
  effectiveQuoteFetchedAt,
  fromProduct, toProduct, swapPriceInvert, currentPrice, swapSummary, priceImpact, routedVia,
  swapRouteItems, swapRouteEmptyMessage,
  selectProvider, onFromInput, onRefreshQuotes, submit: swapSubmit, openSlippageSettings,
  normalizeAddress, clearSimulationError, resetQuoteState,
} = swap

const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()

// Add this collateral swap (or same-asset migration) to the batch. CoW orders
// can't be merged into an EVC batch, so they're excluded.
const isCowSwapSelected = computed(() => isCowProvider(selectedProvider.value))
const canAddToBatch = computed(() => {
  if (isGeoBlocked.value) return false
  if (!fromVault.value || !toVault.value || !position.value || !(+fromAmount.value)) return false
  if (isSameAsset.value) return true
  return !!selectedQuote.value && !isCowSwapSelected.value
})
const { guardWithPriceImpact: guardWithAddToBatchPriceImpact } = usePriceImpactGate({
  directPriceImpact: priceImpact,
  shouldGateUnknown: computed(() =>
    !isSameAsset.value
    && selectedQuote.value !== null
    && priceImpact.value === null,
  ),
})
const addToBatch = async () => {
  if (!canAddToBatch.value) return
  await guardWithAddToBatchPriceImpact(async () => {
    const from = fromVault.value
    const to = toVault.value
    const pos = position.value
    if (!from || !to || !pos) return
    const fromAddr = from.address as Address
    const toAddr = to.address as Address
    const toAssetAddr = to.asset.address as Address
    const positionAccount = pos.subAccount as Address
    const amount = valueToNano(fromAmount.value, from.asset.decimals)
    const isMax = isMaxSwap.value
    const sameAsset = isSameAsset.value
    const swapQuote = sameAsset ? undefined : selectedQuote.value ?? undefined
    // Name the op after the original position pair (e.g. "Refinance BOLD/USDC",
    // "BOLD & others/USDC" for multi-collateral), matching the positions list.
    const pairLabel = pairAssetsLabel.value
      ?? `${pos.collateralVault?.asset.symbol ?? '?'}/${pos.borrowVault?.asset.symbol ?? '?'}`
    const label = `Refinance ${pairLabel}`
    await addBatchEntry({
      label,
      nameOverride: label,
      buildPlan: account => planCollateralChange({
        fromVault: fromAddr,
        toVault: toAddr,
        amount,
        positionAccount,
        toAsset: toAssetAddr,
        isMax,
        enableCollateralTo: true,
        disableCollateralFrom: isMax,
        swapQuote,
        swapperMode: SwapperMode.EXACT_IN,
        account,
      }),
      subAccount: positionAccount,
      review: { type: 'swap', asset: from.asset, amount: fromAmount.value, swapToAsset: to.asset, swapMode: SwapperMode.EXACT_IN, quoteFetchedAt: sameAsset ? null : effectiveQuoteFetchedAt.value },
    })
    fromAmount.value = ''
    redirectAfterAdd('/portfolio', { subAccount: positionAccount })
  })
}

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (errorText.value) return { message: errorText.value, variant: 'error' }
  if (sameVaultError.value) return { message: sameVaultError.value, variant: 'error' }
  if (quoteError.value) return { message: quoteError.value, variant: 'warning' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  if (!isSameAsset.value && isQuoteLoading.value && +fromAmount.value > 0) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (!isSameAsset.value && !selectedQuote.value && +fromAmount.value > 0) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})

// ── Position loading ─────────────────────────────────────────────────────
const getSelectedCollateralAddress = () =>
  (typeof route.query.collateral === 'string' ? route.query.collateral : '')

const loadSelectedCollateral = async () => {
  if (!position.value) {
    selectedCollateral.value = null
    selectedCollateralShares.value = 0n
    selectedCollateralAssets.value = 0n
    return
  }

  const primaryAddress = normalizeAddress(primaryCollateralVault.value?.address)
  const targetAddress = normalizeAddress(getSelectedCollateralAddress()) || primaryAddress

  if (targetAddress !== lastCollateralAddress.value) {
    fromAmount.value = ''
    lastCollateralAddress.value = targetAddress
    resetQuoteState()
  }

  selectedCollateralShares.value = 0n
  selectedCollateralAssets.value = targetAddress === primaryAddress ? position.value.supplied : 0n

  try {
    if (!isEulerAddressesReady.value) {
      await loadEulerConfig()
    }

    await until(isVaultsReady).toBe(true)

    const vault = await getOrFetch(targetAddress) as EVault | SecuritizeCollateralVault | undefined
    selectedCollateral.value = vault || null

    // Collateral assets/shares from the (layer-aware) position rather than a
    // direct lens read, so the form reflects the active batch layer. Unheld ⇒ 0.
    const match = position.value.collaterals.find(c =>
      normalizeAddress(c.vaultAddress) === targetAddress)
    selectedCollateralShares.value = match?.shares ?? (targetAddress === primaryAddress ? (position.value.collateral?.shares ?? 0n) : 0n)
    selectedCollateralAssets.value = match?.assets ?? (targetAddress === primaryAddress ? position.value.supplied : 0n)
  }
  catch (e) {
    logWarn('collateralSwap/loadCollateral', e)
    if (!selectedCollateral.value) {
      selectedCollateral.value = primaryCollateralVault.value || null
    }
  }
}

const loadPosition = async () => {
  if (!isConnected.value && !isSpyMode.value) return
  isLoading.value = true
  await until(isPositionsLoaded).toBe(true)
  await loadSelectedCollateral()
  isLoading.value = false
}

watch([isPositionsLoaded, () => route.params.number], ([loaded]) => {
  if (loaded) {
    loadPosition()
  }
}, { immediate: true })
watch(() => route.query.collateral, async () => {
  if (!position.value) return
  await loadSelectedCollateral()
})

watch([swapTargetVaults, fromVault], ([vaults, sourceVault]) => {
  if (!toVault.value) return

  const toAddress = normalizeVaultAddress(toVault.value.address)
  const fromAddress = normalizeVaultAddress(sourceVault?.address)
  const existsInOptions = vaults.some(v => normalizeVaultAddress(v.address) === toAddress)
  const pointsToSourceVault = !!toAddress && !!fromAddress && toAddress === fromAddress

  if (!existsInOptions || pointsToSourceVault) {
    toVault.value = undefined
  }
}, { immediate: true })

watch([toVault, fromVault], ([targetVault, sourceVault]) => {
  if (!targetVault || !sourceVault) return
  const targetAddress = normalizeVaultAddress(targetVault.address)
  const sourceAddress = normalizeVaultAddress(sourceVault.address)
  if (targetAddress && sourceAddress && targetAddress === sourceAddress) {
    toVault.value = undefined
  }
})

const onToVaultChange = (selectedIndex: number) => {
  clearSimulationError()
  const selectedOption = swapTargetOptions.value[selectedIndex]
  if (!selectedOption?.vaultAddress) return

  const nextVault = swapTargetVaults.value.find(vault =>
    normalizeVaultAddress(vault.address) === normalizeVaultAddress(selectedOption.vaultAddress),
  )
  if (!nextVault) {
    toVault.value = undefined
    return
  }

  if (!toVault.value || normalizeVaultAddress(toVault.value.address) !== normalizeVaultAddress(nextVault.address)) {
    toVault.value = nextVault
  }
}

// ── Supply & borrow APY ──────────────────────────────────────────────────
const fromSupplyApy = computed(() => {
  if (!fromVault.value) return null
  const base = getVaultSupplyApy(fromVault.value)
  return withVaultIntrinsicApy(base, fromVault.value, enableIntrinsicApy.value) + getSupplyRewardApy(fromVault.value.address)
})
const toSupplyApy = computed(() => {
  if (!toVault.value) return null
  const base = getVaultSupplyApy(toVault.value)
  return withVaultIntrinsicApy(base, toVault.value, enableIntrinsicApy.value) + getSupplyRewardApy(toVault.value.address)
})
const borrowApy = computed(() => {
  if (!borrowVault.value) return null
  const base = getVaultBorrowApy(borrowVault.value)
  return withVaultIntrinsicApy(base, borrowVault.value, enableIntrinsicApy.value) - getBorrowRewardApy(borrowVault.value.address, fromVault.value?.address)
})
const projectedCollateralVaults = computed<Array<EVault | SecuritizeCollateralVault>>(() => {
  if (!position.value) return []

  const sourceAddress = normalizeAddress(fromVault.value?.address)
  const targetAddress = normalizeAddress(toVault.value?.address)
  const removesSource = isMaxSwap.value
  const vaults = new Map<string, EVault | SecuritizeCollateralVault>()

  for (const collateralPosition of position.value.collaterals) {
    const vault = collateralPosition.vault
    if (!vault || (!isEVault(vault) && !isSecuritizeCollateralVault(vault))) continue
    const address = normalizeAddress(vault.address)
    if (!address) continue
    if (removesSource && sourceAddress && address === sourceAddress) continue
    vaults.set(address, vault as EVault | SecuritizeCollateralVault)
  }

  if (!vaults.size && fromVault.value) {
    const address = normalizeAddress(fromVault.value.address)
    if (address && !(removesSource && sourceAddress && address === sourceAddress)) {
      vaults.set(address, fromVault.value)
    }
  }

  if (toVault.value && targetAddress) {
    vaults.set(targetAddress, toVault.value)
  }

  return [...vaults.values()]
})
const positionRoeCollateralVaults = computed(() =>
  resolvePositionRoeCollateralVaults(position.value, fromVault.value),
)
const hasSingleCollateralFullSwapRoeScope = computed(() =>
  positionRoeCollateralVaults.value.isComplete
  && positionRoeCollateralVaults.value.vaults.length === 1
  && projectedCollateralVaults.value.length === 1
  && isMaxSwap.value,
)
const isRoeApplicable = computed(() => {
  if (!toVault.value || !borrowVault.value) return false
  if (!hasSingleCollateralFullSwapRoeScope.value) return false
  const collaterals = projectedCollateralVaults.value
  if (!collaterals.length) return false

  return areRoeCollateralVaultsCorrelatedWithBorrow(collaterals, borrowVault.value, getTokenCategoryTags)
})

// ── Collateral USD valuation (from liability vault's perspective) ─────────
const getCollateralValueUsdLocal = async (amount: bigint) => {
  if (!borrowVault.value || !fromVault.value) return 0
  return getCollateralUsdValueOrZero(amount, borrowVault.value, fromVault.value as EVault, 'off-chain')
}
// ── ROE ──────────────────────────────────────────────────────────────────
const supplyValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!fromVault.value || !position.value || !borrowVault.value) {
    supplyValueUsd.value = null
    return
  }
  supplyValueUsd.value = await getCollateralValueUsdLocal(selectedCollateralAssets.value)
})
const nextSupplyValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (isSameAsset.value && toVault.value && fromAmount.value) {
    try {
      const amount = valueToNano(fromAmount.value, toVault.value.asset.decimals)
      nextSupplyValueUsd.value = (await getAssetUsdValue(amount, toVault.value, 'off-chain')) ?? null
    }
    catch {
      nextSupplyValueUsd.value = null
    }
    return
  }
  if (!quote.value || !toVault.value) {
    nextSupplyValueUsd.value = null
    return
  }
  nextSupplyValueUsd.value = (await getAssetUsdValue(BigInt(quote.value.amountOut), toVault.value, 'off-chain')) ?? null
})
const borrowValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!borrowVault.value || !position.value) {
    borrowValueUsd.value = null
    return
  }
  borrowValueUsd.value = (await getAssetUsdValue(position.value.borrowed, borrowVault.value, 'off-chain')) ?? null
})

const roeBefore = computed(() => calculateRoe(supplyValueUsd.value, borrowValueUsd.value, fromSupplyApy.value, borrowApy.value))
const roeAfter = computed(() => calculateRoe(nextSupplyValueUsd.value, borrowValueUsd.value, toSupplyApy.value, borrowApy.value))

// ── Health metrics ───────────────────────────────────────────────────────
const liqPriceInvert = usePriceInvert(
  () => toVault.value?.asset.symbol,
  () => borrowVault.value?.asset.symbol,
)

const priceRatio = computed(() => {
  if (!toVault.value || !borrowVault.value) return null
  const collateralPrice = getCollateralOraclePrice(borrowVault.value, toVault.value)
  const borrowPrice = getAssetOraclePrice(borrowVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
const nextCollateralAmount = computed(() => {
  if (isSameAsset.value && toVault.value && fromAmount.value) {
    try {
      return nanoToValue(valueToNano(fromAmount.value, toVault.value.asset.decimals), toVault.value.shares.decimals)
    }
    catch { return null }
  }
  if (!quote.value || !toVault.value) return null
  return nanoToValue(BigInt(quote.value.amountOut), toVault.value.shares.decimals)
})
const borrowAmount = computed(() => {
  if (!borrowVault.value || !position.value) return null
  return nanoToValue(position.value.borrowed, borrowVault.value.shares.decimals)
})

const currentLtv = computed(() => {
  const ltv = position.value?.userLTV ?? position.value?.currentLTV
  return ltv === undefined ? null : ltvToPercent(nanoToValue(ltv, 18))
})
const fromLiquidationLtv = computed(() => {
  if (!borrowVault.value || !fromVault.value) return null
  const match = borrowVault.value.collaterals.find(
    ltv => normalizeAddress(ltv.address) === normalizeAddress(fromVault.value?.address),
  )
  return match ? ltvToPercent(match.liquidationLTV) : null
})
const nextLiquidationLtv = computed(() => {
  if (!borrowVault.value || !toVault.value) return null
  const match = borrowVault.value.collaterals.find(
    ltv => normalizeAddress(ltv.address) === normalizeAddress(toVault.value?.address),
  )
  return match ? ltvToPercent(match.liquidationLTV) : null
})
// Remaining FROM collateral value after partial swap
const remainingFromValue = computed(() => {
  if (!fromVault.value || !fromAmount.value || !currentPriceRatio.value) return 0
  try {
    const swapped = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
    const remaining = selectedCollateralAssets.value - swapped
    if (remaining <= 0n) return 0
    return nanoToValue(remaining, fromVault.value.shares.decimals) * currentPriceRatio.value
  }
  catch { return 0 }
})
// New TO collateral value from swap output
const newToValue = computed(() => {
  if (!nextCollateralAmount.value || !priceRatio.value) return 0
  if (priceRatio.value <= 0 || nextCollateralAmount.value <= 0) return 0
  return nextCollateralAmount.value * priceRatio.value
})
const nextLtv = computed(() => {
  if (!borrowAmount.value) return null
  const totalValue = remainingFromValue.value + newToValue.value
  if (totalValue <= 0) return null
  return (borrowAmount.value / totalValue) * 100
})
const currentHealth = computed(() => {
  const health = position.value?.healthFactor
  return health === undefined ? null : nanoToValue(health, 18)
})
const nextHealth = computed(() => {
  if (!nextLtv.value || nextLtv.value <= 0) return null
  const totalValue = remainingFromValue.value + newToValue.value
  if (totalValue <= 0) return null
  // Weighted average liquidation LTV across both collateral types
  const weightedLiqLtv = (
    remainingFromValue.value * (fromLiquidationLtv.value ?? 0)
    + newToValue.value * (nextLiquidationLtv.value ?? 0)
  ) / totalValue
  return weightedLiqLtv / nextLtv.value
})
const currentPriceRatio = computed(() => {
  if (!fromVault.value || !borrowVault.value) return null
  const collateralPrice = getCollateralOraclePrice(borrowVault.value, fromVault.value as EVault)
  const borrowPrice = getAssetOraclePrice(borrowVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
const currentLiquidationPrice = computed(() => {
  if (!currentPriceRatio.value || !currentHealth.value) return null
  if (currentHealth.value < 1) return null
  return currentPriceRatio.value / currentHealth.value
})
const nextLiquidationPrice = computed(() => {
  if (!priceRatio.value || !nextHealth.value) return null
  if (nextHealth.value < 1) return null
  return priceRatio.value / nextHealth.value
})

// ── CowSwap collateral swap ─────────────────────────────────────────────
const isCowSwapProvider = computed(() => isCowProvider(selectedProvider.value))

// Pre-flight checks for CoW orders. The execution path can't simulate the
// full settlement (the swap happens off-chain via the solver), so we
// replicate the cheapest invariants that would otherwise be caught by
// simulate: balance, destination supply cap, post-swap health.
const cowSwapErrorText = computed(() => {
  if (!isCowSwapProvider.value || !fromVault.value || !toVault.value || !selectedQuote.value) return null

  const inputNano = valueToNano(fromAmount.value || '0', fromVault.value.asset.decimals)
  if (inputNano > balance.value) return 'Sell amount exceeds collateral balance'

  if (!getCowSwapQuoteOrderAmounts(selectedQuote.value, { slippage: slippage.value, slippageTarget: 'buyAmount' })) {
    return 'Invalid CoW quote: missing order amounts'
  }

  const toV = toVault.value
  const supplyCap = toV.caps?.supplyCap
  if (typeof supplyCap === 'bigint' && supplyCap > 0n && supplyCap < maxUint256) {
    const buyUnderlying = BigInt(selectedQuote.value.amountOut || '0')
    if (toV.totalAssets + buyUnderlying > supplyCap) {
      return 'Supply cap would be exceeded on the destination vault'
    }
  }

  if (nextHealth.value !== null && nextHealth.value < 1) {
    return 'Position would be immediately liquidatable after swap'
  }

  return null
})

const submitCowSwapCollateralSwap = async () => {
  if (!position.value || !fromVault.value || !toVault.value || !selectedQuote.value || !address.value) return
  if (cowSwapErrorText.value) return

  cowSwapExecution.reset()

  const chainId = currentChainId.value ?? 0
  const chainConfig = getCowSwapChainConfig(chainId)
  if (!chainConfig) return

  const validTo = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS

  // The execution composable wraps `sdk.executionService.planSwapCollateralWithCoW`,
  // which derives the wrapper params + order amounts from the quote internally.
  // We still compute order amounts here for the review-modal display.
  const orderAmounts = getCowSwapQuoteOrderAmounts(selectedQuote.value, {
    slippage: slippage.value,
    slippageTarget: 'buyAmount',
  })
  if (!orderAmounts) {
    logWarn('collateralSwap/cowswap/orderAmounts', new Error('Invalid CoW quote: missing order amounts'))
    return
  }
  const { sellAmount, buyAmount } = orderAmounts

  const sdkAccount = freshAccount.value
  if (!sdkAccount) {
    logWarn('collateralSwap/cowswap/noAccount', new Error('Account not ready'))
    return
  }

  const cowParams: CowSwapCollateralSwapExecuteParams = {
    chainId,
    account: sdkAccount,
    swapQuote: selectedQuote.value,
    slippage: slippage.value,
    validTo,
    disableSourceCollateral: isMaxSwap.value,
  }

  // Read current vault-shares allowance to the CoW VaultRelayer so the review
  // modal can decide whether to insert an "Approve" step (and a USDT-style
  // zero-reset step) before the actual approval.
  let currentAllowance = 0n
  try {
    const client = rpcClient.value
    if (client) {
      currentAllowance = await client.readContract({
        address: fromVault.value.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        authorizationList: undefined,
        args: [address.value as Address, chainConfig.vaultRelayer],
      }) as bigint
    }
  }
  catch {
    // Default to showing approval step
  }

  const fromAsset = fromVault.value.asset
  const toAsset = toVault.value.asset
  // For an EVault, share decimals match the underlying asset decimals.
  const fromShareAmount = trimTrailingZeros(formatUnits(sellAmount, Number(fromVault.value.asset.decimals)))
  const fromAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(fromVault.value, sellAmount), Number(fromAsset.decimals)))
  const toAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(toVault.value, buyAmount), Number(toAsset.decimals)))

  const signSteps: DisplayStep[] = []
  let idx = 1
  const approval = buildApprovalSignSteps({
    chainId,
    tokenAddress: fromVault.value.address as Address,
    currentAllowance,
    requiredAmount: sellAmount,
    label: 'Approve for swap',
    assetInfo: { symbol: fromAsset.symbol, address: fromVault.value.address, iconAddress: fromAsset.address, amount: fromShareAmount },
    startIndex: idx,
  })
  signSteps.push(...approval.steps)
  idx = approval.nextIndex
  signSteps.push({ index: idx++, label: 'Sign EVC permit', isSeparateTx: false })
  signSteps.push({ index: idx++, label: 'Sign CoW order', isSeparateTx: false })

  let wIdx = 1
  const wrapperSteps: DisplayStep[] = [
    { index: wIdx++, label: 'Enable collateral', labelSuffix: toAsset.symbol, isSeparateTx: false },
    ...(isMaxSwap.value ? [{ index: wIdx++, label: 'Disable source collateral', labelSuffix: fromAsset.symbol, isSeparateTx: false }] : []),
    { index: wIdx++, label: 'Transfer to wallet', isSeparateTx: false, assetInfo: { symbol: fromAsset.symbol, address: fromVault.value.address, iconAddress: fromAsset.address, amount: fromShareAmount } },
    { index: wIdx++, label: 'Swap', isSeparateTx: false, assetInfo: { symbol: fromAsset.symbol, address: fromAsset.address, amount: fromAssetAmount }, toAssetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetAmount } },
    { index: wIdx++, label: 'Verify min received', isSeparateTx: false, assetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetAmount } },
  ]

  const walletWarningsDescription
    = 'The CoW order and transfer steps use vault-share amounts. Swap and received amounts are shown in underlying assets. '
      + 'The CoW order receiver is your sub-account, not your main wallet — your wallet may flag this as a mismatch. '
      + 'You can verify the first 19 bytes (38 hex chars after "0x") of the receiver match your wallet address.'

  openCowSwapReviewModal(cowModal, {
    signSteps,
    wrapperSteps,
    walletWarningsDescription,
    execution: cowSwapExecution,
    orderStatus: cowSwapOrderStatus,
    executeParams: cowParams,
    quoteFetchedAt: effectiveQuoteFetchedAt.value,
    logPrefix: 'collateralSwap/cowswap',
  })
}

const submit = () => {
  if (isCowSwapProvider.value) {
    void submitCowSwapCollateralSwap()
  }
  else {
    void swapSubmit()
  }
}

// Watch for CowSwap order completion → refresh portfolio + bounce to it.
const router = useRouter()
const { refreshAllPositions } = useEulerAccount()

watch(() => cowSwapOrderStatus.orderStatus.value, (status) => {
  if (!status?.terminal) return
  if (status.type === 'traded' || status.type === 'fulfilled') {
    refreshAllPositions(undefined, address.value as string)
    cowModal.close()
    setTimeout(() => {
      router.replace('/portfolio')
      cowSwapExecution.reset()
    }, 400)
  }
  // else: leave terminal status visible until user dismisses the modal.
})
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
      title="Swap collateral"
      description="Exchange your collateral for a different asset while keeping your position open."
      class="flex flex-col gap-16 w-full"
      :loading="isLoading || isPositionsLoading"
      @submit.prevent="submit"
    >
      <template v-if="fromVault">
        <VaultLabelsAndAssets
          :vault="fromVault"
          :assets="[fromVault.asset]"
          :assets-label="pairAssetsLabel"
          size="large"
        />
        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-model="fromAmount"
              :desc="fromProduct.name"
              label="From"
              :asset="fromVault.asset"
              :vault="fromVault"
              :balance="balance"
              maxable
              @input="onFromInput"
            />

            <SwapRouteSelector
              v-if="toVault && !isSameAsset"
              :items="swapRouteItems"
              :selected-provider="selectedProvider"
              :status-label="quotesStatusLabel"
              :is-loading="isQuoteLoading"
              :empty-message="swapRouteEmptyMessage"
              @select="selectProvider"
              @refresh="onRefreshQuotes"
            />

            <AssetInput
              v-if="toVault"
              v-model="toAmount"
              :desc="toProduct.name"
              label="To"
              :asset="toVault.asset"
              :vault="toVault"
              :collateral-options="swapTargetOptions"
              :readonly="true"
              @change-collateral="onToVaultChange"
            />
            <UiAlert
              v-else-if="!isLoading && !isPositionsLoading"
              title="No collateral swap options"
              description="There are no other vaults that accept this collateral for this position."
              variant="warning"
              size="compact"
            />

            <UiAlert
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-show="errorText || cowSwapErrorText"
              title="Error"
              variant="error"
              :description="cowSwapErrorText || errorText || ''"
              size="compact"
            />
            <UiAlert
              v-if="toVault && sameVaultError"
              title="Error"
              variant="error"
              :description="sameVaultError"
              size="compact"
            />
            <UiAlert
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <UiAlert
              v-if="toVault && quoteError"
              title="Swap quote"
              variant="warning"
              :description="quoteError"
              size="compact"
            />

            <div
              v-if="toVault"
              class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2"
            >
              <VaultFormSubmit
                :disabled="reviewSwapDisabled || !!cowSwapErrorText"
                :loading="isSubmitting || isPreparing"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
                :can-add-to-batch="canAddToBatch"
                @add-to-batch="addToBatch"
              >
                {{ reviewSwapLabel }}
              </VaultFormSubmit>
            </div>
          </div>

          <VaultFormInfoBlock
            v-if="toVault"
            :loading="!isSameAsset && isQuoteLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow
              v-if="isRoeApplicable"
              label="ROE"
            >
              <SummaryValue
                :before="roeBefore !== null ? formatNumber(roeBefore) : undefined"
                :after="roeAfter !== null && (quote || isSameAsset) ? formatNumber(roeAfter) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <template v-if="!isSameAsset">
              <SummaryRow
                label="Swap price"
                align-top
              >
                <SummaryPriceValue
                  :value="currentPrice ? formatSmartAmount(swapPriceInvert.invertValue(currentPrice.value)) : undefined"
                  :symbol="swapPriceInvert.displaySymbol"
                  invertible
                  @invert="swapPriceInvert.toggle"
                />
              </SummaryRow>
            </template>
            <template v-else>
              <SummaryRow label="Transfer">
                <p class="text-p2">
                  1:1 (same asset, no slippage)
                </p>
              </SummaryRow>
            </template>
            <SummaryRow
              label="Liq. price"
              align-top
            >
              <SummaryPriceValue
                :before="liqPriceInvert.invertValue(currentLiquidationPrice) != null ? formatSmartAmount(liqPriceInvert.invertValue(currentLiquidationPrice)!) : undefined"
                :after="nextLiquidationPrice !== null && (quote || isSameAsset) ? formatSmartAmount(liqPriceInvert.invertValue(nextLiquidationPrice)) : undefined"
                :symbol="liqPriceInvert.displaySymbol"
                invertible
                @invert="liqPriceInvert.toggle"
              />
            </SummaryRow>
            <SummaryRow label="Liq. buffer">
              <SummaryValue
                :before="formatLiqBuffer(liqPriceInvert.invertValue(currentPriceRatio), liqPriceInvert.invertValue(currentLiquidationPrice))"
                :after="nextLiquidationPrice !== null && (quote || isSameAsset)
                  ? formatLiqBuffer(liqPriceInvert.invertValue(priceRatio), liqPriceInvert.invertValue(nextLiquidationPrice))
                  : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="LTV">
              <SummaryValue
                :before="currentLtv !== null ? formatNumber(currentLtv) : undefined"
                :after="nextLtv !== null && (quote || isSameAsset) ? formatNumber(nextLtv) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="currentHealth !== null ? formatHealthScore(currentHealth) : undefined"
                :after="nextHealth !== null && (quote || isSameAsset) ? formatHealthScore(nextHealth) : undefined"
              />
            </SummaryRow>
            <SwapDetailsSummary
              v-if="!isSameAsset"
              :input-display="swapSummary?.from ?? null"
              :output-display="swapSummary?.to ?? null"
              :price-impact="priceImpact"
              :slippage="slippage"
              :routed-via="routedVia"
              @open-slippage-settings="openSlippageSettings"
            />
          </VaultFormInfoBlock>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
