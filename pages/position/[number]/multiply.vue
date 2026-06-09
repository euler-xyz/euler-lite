<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import { getAssetUsdValue, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { computeMultipliedPriceImpact } from '~/utils/priceImpact'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { isEVault, type EVault, type PortfolioBorrowPosition, type SwapQuote, type TransactionPlan, type TransactionPlanPrepared, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { formatNumber, formatSmartAmount, formatHealthScore, trimTrailingZeros } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer, calculateRoe, computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { getNetAPY } from '~/utils/vault/apy'
import { nanoToValue } from '~/utils/crypto-utils'
import { computeMaxMultiplier } from '~/utils/multiply-math'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { SlippageSettingsModal, OperationReviewModal } from '#components'
import { formatUnits, type Address } from 'viem'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'

const route = useRoute()
const router = useRouter()
const modal = useModal()
const { error } = useToast()
const { address, isConnected } = useWagmi()
const { isSpyMode } = useSpyMode()
const { isPositionsLoading, isPositionsLoaded, refreshAllPositions, getPositionBySubAccountIndex } = useEulerAccount()
const { planMultiply, prepareTransactionPlan, executePreparedPlan, prefetchPluginData, preloadSubAccountSnapshot } = useEulerTx()
const { account: planAccount } = usePlanAccount()
const { eulerLensAddresses } = useEulerAddresses()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { areAssetsCorrelated, getAssetCorrelationLabel } = useTokenCorrelation()
const {
  runPreparedSimulation: runMultiplySimulation,
  simulationError: multiplySimulationError,
  clearSimulationError: clearMultiplySimulationError,
} = useTransactionPlanSimulation()
const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

const priceInvert = usePriceInvert(
  () => multiplyShortVault.value?.asset.symbol,
  () => multiplyLongVault.value?.asset.symbol,
)

const positionIndex = usePositionIndex()
const position: Ref<PortfolioBorrowPosition<VaultEntity> | null> = ref(null)

const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const plan = ref<TransactionPlan | null>(null)
const preparedPlan = shallowRef<TransactionPlanPrepared | null>(null)

const multiplier = ref(1)
const multiplyLongAmount = ref('')
const multiplyShortAmount = ref('')
const multiplySupplyVault: Ref<EVault | undefined> = ref()

const { slippage: multiplySlippage } = useSlippage({
  fromSymbol: () => multiplyShortVault.value?.asset.symbol,
  toSymbol: () => multiplyLongVault.value?.asset.symbol,
})
const {
  sortedQuoteCards: multiplyQuoteCardsSorted,
  selectedProvider: multiplySelectedProvider,
  selectedQuote: multiplySelectedQuote,
  effectiveQuote: multiplyEffectiveQuote,
  effectiveQuoteFetchedAt: multiplyEffectiveQuoteFetchedAt,
  providersCount: multiplyProvidersCount,
  isLoading: isMultiplyQuoteLoading,
  quoteError: multiplyQuoteError,
  statusLabel: multiplyQuotesStatusLabel,
  getQuoteDiffPct,
  reset: resetMultiplyQuoteStateInternal,
  requestQuotes: requestMultiplyQuotes,
  selectProvider: selectMultiplyQuote,
} = useSwapQuotesParallel({
  amountField: 'amountOut',
  compare: 'max',
  buildTxPlanForQuote: (quote, _provider, context) => buildMultiplyPlanFromQuote(quote, context.account),
  getPlanAccount: () => planAccount.value,
  prefetchPluginData: (plan, account) => prefetchPluginData(plan, { account }),
})
const multiplyLongVault = computed<EVault | undefined>(() => {
  const vault = position.value ? position.value.collateralVault : undefined
  return vault && isEVault(vault) ? vault : undefined
})
const multiplyShortVault = computed<EVault | undefined>(() => position.value ? position.value.borrowVault as EVault | undefined : undefined)
const multiplySubAccount = computed(() => position.value?.subAccount || null)
useOperationGuard(computed(() => [multiplySupplyVault.value?.address, multiplyLongVault.value?.address, multiplyShortVault.value?.address].filter(Boolean)))

const pairAssets = computed<VaultAsset[]>(() => {
  if (!multiplyLongVault.value || !multiplyShortVault.value) {
    return []
  }
  return [multiplyLongVault.value.asset, multiplyShortVault.value.asset]
})
const pairAssetsLabel = usePositionPairLabel(position)
const isPairCorrelated = computed(() =>
  !!multiplyLongVault.value && !!multiplyShortVault.value && areAssetsCorrelated(multiplyLongVault.value.asset, multiplyShortVault.value.asset),
)
const pairCorrelationCategory = computed(() =>
  getAssetCorrelationLabel(multiplyLongVault.value?.asset.address, multiplyLongVault.value?.asset.symbol),
)

const multiplyLongProduct = useEulerProductOfVault(computed(() => multiplyLongVault.value?.address || ''))
const multiplyShortProduct = useEulerProductOfVault(computed(() => multiplyShortVault.value?.address || ''))

const normalizeAddress = normalizeAddressOrEmpty

const multiplyRouteItems = computed(() => {
  if (!multiplyLongVault.value) return []
  return buildSwapRouteItems({
    quoteCards: multiplyQuoteCardsSorted.value,
    getQuoteDiffPct,
    decimals: Number(multiplyLongVault.value.asset.decimals),
    symbol: multiplyLongVault.value.asset.symbol,
    formatAmount: formatSmartAmount,
  })
})
const multiplyRouteEmptyMessage = computed(() => {
  if (!multiplyProvidersCount.value) {
    return 'Increase multiplier to fetch quotes'
  }
  return 'No quotes found'
})

const multiplySupplyApy = computed(() => {
  if (!multiplySupplyVault.value) {
    return null
  }
  const base = getVaultSupplyApy(multiplySupplyVault.value)
  return withVaultIntrinsicApy(base, multiplySupplyVault.value, enableIntrinsicApy.value) + getSupplyRewardApy(multiplySupplyVault.value.address)
})
const multiplyLongApy = computed(() => {
  if (!multiplyLongVault.value) {
    return null
  }
  const base = getVaultSupplyApy(multiplyLongVault.value)
  return withVaultIntrinsicApy(base, multiplyLongVault.value, enableIntrinsicApy.value) + getSupplyRewardApy(multiplyLongVault.value.address)
})
const multiplyBorrowApy = computed(() => {
  if (!multiplyShortVault.value) {
    return null
  }
  const base = getVaultBorrowApy(multiplyShortVault.value)
  return withVaultIntrinsicApy(base, multiplyShortVault.value, enableIntrinsicApy.value) - getBorrowRewardApy(multiplyShortVault.value.address, multiplySupplyVault.value?.address)
})

const multiplyDebtAmountNano = computed(() => {
  const currentBorrowed = position.value?.borrowed || 0n
  const currentMultiple = multiplyCurrentMultiple.value
  const targetMultiple = multiplier.value
  if (!currentBorrowed || !currentMultiple || targetMultiple <= currentMultiple) {
    return 0n
  }
  const numerator = BigInt(Math.floor((targetMultiple - 1) * 100_000))
  const denominator = Math.floor((currentMultiple - 1) * 100_000)
  if (denominator <= 0) {
    return (currentBorrowed * numerator) / 100_000n
  }
  const newLiability = (currentBorrowed * numerator) / BigInt(denominator)
  if (newLiability <= currentBorrowed) {
    return 0n
  }
  return newLiability - currentBorrowed
})
const multiplyBorrowLtv = computed(() => {
  if (!multiplySupplyVault.value || !multiplyShortVault.value) {
    return 0
  }
  const match = multiplyShortVault.value.collaterals.find(
    ltv => normalizeAddress(ltv.address) === normalizeAddress(multiplySupplyVault.value?.address),
  )
  return match ? ltvToPercent(match.borrowLTV) : 0
})
const multiplyMaxMultiplier = computed(() => computeMaxMultiplier(multiplyBorrowLtv.value))
const multiplyCurrentMultiple = computed(() => {
  if (!position.value) {
    return 1
  }
  const ltvValue = position.value.userLTV ?? position.value.currentLTV
  if (ltvValue === undefined) return 1
  const ltv = nanoToValue(ltvValue, 18)
  if (!Number.isFinite(ltv) || ltv <= 0) {
    return 1
  }
  const rawMultiple = ltv >= 0.9999 ? multiplyMaxMultiplier.value : 1 / (1 - ltv)
  const rounded = Math.max(1, Math.round(rawMultiple * 100) / 100)
  return Math.min(rounded, multiplyMaxMultiplier.value || rounded)
})
const multiplyMinMultiplier = computed(() => {
  const current = multiplyCurrentMultiple.value
  if (!current || !Number.isFinite(current)) {
    return multiplyMaxMultiplier.value <= 1 ? 0 : 1
  }
  return Math.min(current, multiplyMaxMultiplier.value || current)
})
const multiplyIsSameAsset = computed(() => {
  if (!multiplyShortVault.value || !multiplyLongVault.value) {
    return false
  }
  return normalizeAddress(multiplyShortVault.value.asset.address) === normalizeAddress(multiplyLongVault.value.asset.address)
})
const multiplySwapAmountIn = computed(() => {
  if (multiplyEffectiveQuote.value) {
    return BigInt(multiplyEffectiveQuote.value.amountIn || 0)
  }
  if (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n) {
    return multiplyDebtAmountNano.value
  }
  return 0n
})
const multiplySwapAmountOut = computed(() => {
  if (multiplyEffectiveQuote.value) {
    return BigInt(multiplyEffectiveQuote.value.amountOut || 0)
  }
  if (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n) {
    return multiplyDebtAmountNano.value
  }
  return 0n
})
const multiplySwapReady = computed(() => {
  if (isMultiplyQuoteLoading.value) {
    return false
  }
  return Boolean(multiplyEffectiveQuote.value || (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n))
})
const multiplyLongValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!multiplyLongVault.value) {
    multiplyLongValueUsd.value = null
    return
  }
  if (!multiplySwapAmountOut.value) {
    multiplyLongValueUsd.value = null
    return
  }
  multiplyLongValueUsd.value = (await getAssetUsdValue(multiplySwapAmountOut.value, multiplyLongVault.value, 'off-chain')) ?? null
})
const multiplyBorrowValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!multiplyShortVault.value) {
    multiplyBorrowValueUsd.value = null
    return
  }
  if (!multiplyDebtAmountNano.value) {
    multiplyBorrowValueUsd.value = null
    return
  }
  multiplyBorrowValueUsd.value = (await getAssetUsdValue(multiplyDebtAmountNano.value, multiplyShortVault.value, 'off-chain')) ?? null
})
const currentSupplyValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!position.value || !multiplyLongVault.value) {
    currentSupplyValueUsd.value = null
    return
  }
  currentSupplyValueUsd.value = (await getAssetUsdValue(position.value.supplied, multiplyLongVault.value, 'off-chain')) ?? null
})
const currentBorrowValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!position.value || !multiplyShortVault.value) {
    currentBorrowValueUsd.value = null
    return
  }
  currentBorrowValueUsd.value = (await getAssetUsdValue(position.value.borrowed, multiplyShortVault.value, 'off-chain')) ?? null
})
const nextSupplyValueUsd = computed(() => {
  if (currentSupplyValueUsd.value === null) {
    return null
  }
  return currentSupplyValueUsd.value + (multiplyLongValueUsd.value || 0)
})
const nextBorrowValueUsd = computed(() => {
  if (currentBorrowValueUsd.value === null) {
    return null
  }
  return currentBorrowValueUsd.value + (multiplyBorrowValueUsd.value || 0)
})
const multiplyWeightedSupplyApy = computed(() => {
  if (currentSupplyValueUsd.value === null || multiplyLongApy.value === null) {
    return null
  }
  const longUsd = multiplyLongValueUsd.value || 0
  const total = currentSupplyValueUsd.value + longUsd
  if (!Number.isFinite(total) || total <= 0) {
    return null
  }
  const supplyApy = multiplySupplyApy.value ?? multiplyLongApy.value
  return (currentSupplyValueUsd.value * supplyApy + longUsd * multiplyLongApy.value) / total
})
const multiplyRoeBefore = computed(() => {
  return calculateRoe(
    currentSupplyValueUsd.value,
    currentBorrowValueUsd.value,
    multiplyLongApy.value,
    multiplyBorrowApy.value,
  )
})
const multiplyRoeAfter = computed(() => {
  return calculateRoe(
    nextSupplyValueUsd.value,
    nextBorrowValueUsd.value,
    multiplyWeightedSupplyApy.value,
    multiplyBorrowApy.value,
  )
})
const multiplyNetApyBefore = computed(() => {
  if (
    currentSupplyValueUsd.value === null
    || currentBorrowValueUsd.value === null
    || multiplyLongApy.value === null
    || multiplyBorrowApy.value === null
  ) {
    return null
  }
  return getNetAPY(
    currentSupplyValueUsd.value,
    multiplyLongApy.value,
    currentBorrowValueUsd.value,
    multiplyBorrowApy.value,
  )
})
const multiplyNetApyAfter = computed(() => {
  if (
    nextSupplyValueUsd.value === null
    || nextBorrowValueUsd.value === null
    || multiplyWeightedSupplyApy.value === null
    || multiplyBorrowApy.value === null
  ) {
    return null
  }
  return getNetAPY(
    nextSupplyValueUsd.value,
    multiplyWeightedSupplyApy.value,
    nextBorrowValueUsd.value,
    multiplyBorrowApy.value,
  )
})
const multiplyLiquidationLtv = computed(() => {
  if (!multiplySupplyVault.value || !multiplyShortVault.value) {
    return null
  }
  const match = multiplyShortVault.value.collaterals.find(
    ltv => normalizeAddress(ltv.address) === normalizeAddress(multiplySupplyVault.value?.address),
  )
  return match ? ltvToPercent(match.liquidationLTV) : null
})
const multiplyCurrentLtv = computed(() => {
  if (!position.value) {
    return null
  }
  const ltv = position.value.userLTV ?? position.value.currentLTV
  return ltv === undefined ? null : ltvToPercent(nanoToValue(ltv, 18))
})
const multiplyNextLtv = computed(() => {
  if (nextBorrowValueUsd.value === null || nextSupplyValueUsd.value === null) {
    return null
  }
  if (nextSupplyValueUsd.value <= 0) {
    return null
  }
  return (nextBorrowValueUsd.value / nextSupplyValueUsd.value) * 100
})
const multiplyCurrentLiquidationLtv = computed(() => {
  if (!position.value) {
    return null
  }
  const liquidationLTV = getBorrowPositionEffectiveLiquidationLTV(position.value)
  return liquidationLTV === undefined ? null : ltvToPercent(liquidationLTV)
})
const multiplyNextLiquidationLtv = computed(() => {
  return multiplyLiquidationLtv.value ?? multiplyCurrentLiquidationLtv.value
})
const multiplyCurrentHealth = computed(() => {
  if (!position.value) {
    return null
  }
  const health = position.value.healthFactor
  return health === undefined ? null : nanoToValue(health, 18)
})
const multiplyNextHealth = computed(() => {
  if (!multiplyNextLiquidationLtv.value || !multiplyNextLtv.value) {
    return null
  }
  return computeNextHealth(multiplyNextLiquidationLtv.value, multiplyNextLtv.value)
})
const multiplyPriceRatio = computed(() => {
  if (!multiplyLongVault.value || !multiplyShortVault.value) {
    return null
  }
  // Use liability vault's (multiplyShortVault) view of collateral price (multiplyLongVault is the collateral)
  const collateralPrice = getCollateralOraclePrice(multiplyShortVault.value, multiplyLongVault.value)
  const borrowPrice = getAssetOraclePrice(multiplyShortVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
priceInvert.autoInvert(() => multiplyPriceRatio.value)
const multiplyCurrentLiquidationPrice = computed(() => {
  if (!multiplyPriceRatio.value || !multiplyCurrentHealth.value) {
    return null
  }
  return computeLiquidationPrice(multiplyPriceRatio.value, multiplyCurrentHealth.value)
})
const multiplyNextLiquidationPrice = computed(() => {
  if (!multiplyPriceRatio.value || !multiplyNextHealth.value) {
    return null
  }
  return computeLiquidationPrice(multiplyPriceRatio.value, multiplyNextHealth.value)
})
const multiplyCurrentPrice = computed(() => {
  if (isMultiplyQuoteLoading.value) {
    return null
  }
  if (!multiplySwapReady.value || !multiplyShortVault.value || !multiplyLongVault.value) {
    return null
  }
  const amountIn = Number(formatUnits(multiplySwapAmountIn.value, Number(multiplyShortVault.value.asset.decimals)))
  const amountOut = Number(formatUnits(multiplySwapAmountOut.value, Number(multiplyLongVault.value.asset.decimals)))
  if (!amountIn || !amountOut) {
    return null
  }
  return {
    value: amountIn / amountOut,
    symbol: `${multiplyShortVault.value.asset.symbol}/${multiplyLongVault.value.asset.symbol}`,
  }
})
const multiplySwapSummary = computed(() => {
  if (isMultiplyQuoteLoading.value) {
    return null
  }
  if (!multiplySwapReady.value || !multiplyShortVault.value || !multiplyLongVault.value) {
    return null
  }
  const amountIn = formatUnits(multiplySwapAmountIn.value, Number(multiplyShortVault.value.asset.decimals))
  const amountOut = formatUnits(multiplySwapAmountOut.value, Number(multiplyLongVault.value.asset.decimals))
  return {
    from: `${formatSmartAmount(amountIn)} ${multiplyShortVault.value.asset.symbol}`,
    to: `${formatSmartAmount(amountOut)} ${multiplyLongVault.value.asset.symbol}`,
  }
})
const multiplyPriceImpact = ref<number | null>(null)
watchEffect(async () => {
  if (isMultiplyQuoteLoading.value) {
    multiplyPriceImpact.value = null
    return
  }
  if (!multiplySwapReady.value || !multiplyShortVault.value || !multiplyLongVault.value) {
    multiplyPriceImpact.value = null
    return
  }
  const amountInUsd = await getAssetUsdValue(multiplySwapAmountIn.value, multiplyShortVault.value, 'off-chain')
  const amountOutUsd = await getAssetUsdValue(multiplySwapAmountOut.value, multiplyLongVault.value, 'off-chain')
  if (!amountInUsd || !amountOutUsd) {
    multiplyPriceImpact.value = null
    return
  }
  const impact = (amountOutUsd / amountInUsd - 1) * 100
  if (!Number.isFinite(impact)) {
    multiplyPriceImpact.value = null
    return
  }
  multiplyPriceImpact.value = impact
})
const multipliedPriceImpact = computed(() =>
  computeMultipliedPriceImpact(multiplyPriceImpact.value, multiplier.value),
)
const { guardWithPriceImpact } = usePriceImpactGate({
  directPriceImpact: multiplyPriceImpact,
  multipliedPriceImpact,
  shouldGateUnknown: computed(() =>
    !multiplyIsSameAsset.value
    && multiplyEffectiveQuote.value !== null
    && multiplyPriceImpact.value === null,
  ),
})
const multiplyRoutedVia = computed(() => {
  if (!multiplySelectedProvider.value) return isMultiplyQuoteLoading.value ? null : 'Not selected'
  if (!multiplyEffectiveQuote.value?.route?.length) return null
  return multiplyEffectiveQuote.value.route.map(route => route.providerName).join(', ')
})
const multiplyErrorText = computed(() => {
  if (!multiplyShortVault.value) {
    return null
  }
  if (multiplyDebtAmountNano.value > 0n && multiplyShortVault.value.availableLiquidity < multiplyDebtAmountNano.value) {
    return 'Not enough liquidity in the vault'
  }
  return null
})

const setMultiplyAmounts = (longDelta?: bigint | null, shortDelta?: bigint | null) => {
  if (!position.value || !multiplyLongVault.value || !multiplyShortVault.value) {
    multiplyLongAmount.value = ''
    multiplyShortAmount.value = ''
    return
  }
  const baseLong = position.value.supplied || 0n
  const baseShort = position.value.borrowed || 0n
  const totalLong = baseLong + (longDelta && longDelta > 0n ? longDelta : 0n)
  const totalShort = baseShort + (shortDelta && shortDelta > 0n ? shortDelta : 0n)
  multiplyLongAmount.value = totalLong > 0n
    ? trimTrailingZeros(formatUnits(totalLong, Number(multiplyLongVault.value.asset.decimals)))
    : ''
  multiplyShortAmount.value = totalShort > 0n
    ? trimTrailingZeros(formatUnits(totalShort, Number(multiplyShortVault.value.asset.decimals)))
    : ''
}

watch(
  [position, multiplyEffectiveQuote, multiplyIsSameAsset, multiplyDebtAmountNano, multiplyLongVault, multiplyShortVault],
  () => {
    if (multiplyIsSameAsset.value && multiplyDebtAmountNano.value > 0n) {
      setMultiplyAmounts(multiplyDebtAmountNano.value, multiplyDebtAmountNano.value)
      return
    }
    if (multiplyEffectiveQuote.value) {
      const amountOut = BigInt(multiplyEffectiveQuote.value.amountOut || 0)
      const amountIn = BigInt(multiplyEffectiveQuote.value.amountIn || 0)
      setMultiplyAmounts(amountOut, amountIn)
      return
    }
    setMultiplyAmounts(null, null)
  },
  { immediate: true },
)

const resetMultiplyQuoteState = () => {
  resetMultiplyQuoteStateInternal()
  setMultiplyAmounts(null, null)
}

const onRefreshMultiplyQuotes = () => {
  resetMultiplyQuoteState()
  isMultiplyQuoteLoading.value = true
  requestMultiplyQuote()
}

let multiplySubAccountSnapshotKey: string | null = null
let multiplySubAccountSnapshotPromise: Promise<boolean> | null = null
const ensureMultiplySubAccountSnapshot = (subAccount: Address): Promise<boolean> => {
  const account = planAccount.value
  if (!account) return Promise.resolve(false)
  const key = `${account.chainId}:${normalizeAddress(subAccount)}`
  if (multiplySubAccountSnapshotKey !== key) {
    multiplySubAccountSnapshotKey = key
    multiplySubAccountSnapshotPromise = null
  }
  if (!multiplySubAccountSnapshotPromise) {
    multiplySubAccountSnapshotPromise = preloadSubAccountSnapshot(account, subAccount)
      .then(() => true)
      .catch((e) => {
        console.warn('[Multiply] failed to preload sub-account snapshot', e)
        return false
      })
  }
  return multiplySubAccountSnapshotPromise
}

async function buildMultiplyPlanFromQuote(quote: SwapQuote, account = planAccount.value): Promise<TransactionPlan> {
  if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value) {
    throw new Error('Multiply vaults not loaded')
  }
  const subAccount = multiplySubAccount.value
  if (!subAccount) throw new Error('Sub-account not resolved')
  const debtAmount = multiplyDebtAmountNano.value
  if (debtAmount <= 0n) throw new Error('Debt amount not set')
  const subAccountSnapshotApplied = await ensureMultiplySubAccountSnapshot(subAccount as Address)
  return planMultiply({
    collateralVault: multiplySupplyVault.value.address as Address,
    collateralAmount: 0n,
    collateralAsset: multiplySupplyVault.value.asset.address as Address,
    longVault: multiplyLongVault.value.address as Address,
    liabilityVault: multiplyShortVault.value.address as Address,
    liabilityAmount: debtAmount,
    receiver: subAccount as Address,
    swapQuote: quote,
    swapperMode: SwapperMode.EXACT_IN,
    account,
    subAccountSnapshotApplied,
  })
}

const requestMultiplyQuote = useDebounceFn(async () => {
  multiplyQuoteError.value = null

  if (!multiplyLongVault.value || !multiplyShortVault.value) {
    resetMultiplyQuoteState()
    return
  }

  const debtAmount = multiplyDebtAmountNano.value
  if (!debtAmount || debtAmount <= 0n) {
    resetMultiplyQuoteState()
    return
  }

  if (normalizeAddress(multiplyLongVault.value.asset.address) === normalizeAddress(multiplyShortVault.value.asset.address)) {
    resetMultiplyQuoteState()
    setMultiplyAmounts(debtAmount, debtAmount)
    return
  }

  const subAccount = multiplySubAccount.value
  if (!subAccount) {
    resetMultiplyQuoteState()
    multiplyQuoteError.value = 'Unable to resolve position'
    return
  }
  await ensureMultiplySubAccountSnapshot(subAccount as Address)

  setMultiplyAmounts(null, null)
  const requestParams = {
    tokenIn: multiplyShortVault.value.asset.address as Address,
    tokenOut: multiplyLongVault.value.asset.address as Address,
    accountIn: subAccount as Address,
    accountOut: subAccount as Address,
    amount: debtAmount,
    vaultIn: multiplyShortVault.value.address as Address,
    receiver: multiplyLongVault.value.address as Address,
    slippage: multiplySlippage.value,
    swapperMode: SwapperMode.EXACT_IN,
    isRepay: false,
    targetDebt: 0n,
    currentDebt: 0n,
  }
  await requestMultiplyQuotes(requestParams, {
    errorMessage: 'Unable to fetch swap quote. Multiply feature is not available for this asset.',
  })
}, 500)

const onMultiplierInput = () => {
  clearMultiplySimulationError()
  requestMultiplyQuote()
}

const submitMultiply = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value || isGeoBlocked.value || isMultiplyRestricted.value) return
  isPreparing.value = true
  try {
    await guardWithPriceImpact(async () => {
      if (isSubmitting.value || !isConnected.value) {
        return
      }
      if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value) {
        return
      }
      const debtAmount = multiplyDebtAmountNano.value
      if (debtAmount <= 0n) {
        return
      }
      if (multiplyErrorText.value) {
        return
      }
      const subAccount = multiplySubAccount.value
      if (!subAccount) {
        error('Unable to resolve position')
        return
      }

      const isSameAsset = normalizeAddress(multiplyLongVault.value.asset.address) === normalizeAddress(multiplyShortVault.value.asset.address)
      const quote = isSameAsset ? null : multiplySelectedQuote.value
      if (!isSameAsset && !quote) {
        return
      }

      try {
        const account = planAccount.value
        const subAccountSnapshotApplied = await ensureMultiplySubAccountSnapshot(subAccount as Address)
        plan.value = await planMultiply({
          collateralVault: multiplySupplyVault.value.address as Address,
          collateralAmount: 0n,
          collateralAsset: multiplySupplyVault.value.asset.address as Address,
          longVault: multiplyLongVault.value.address as Address,
          liabilityVault: multiplyShortVault.value.address as Address,
          liabilityAmount: debtAmount,
          receiver: subAccount as Address,
          swapQuote: quote ?? undefined,
          swapperMode: SwapperMode.EXACT_IN,
          account,
          subAccountSnapshotApplied,
        })
        preparedPlan.value = await prepareTransactionPlan(plan.value, { account })
      }
      catch (e) {
        console.warn('[Multiply] failed to build plan', e)
        plan.value = null
        preparedPlan.value = null
      }

      if (preparedPlan.value) {
        const ok = await runMultiplySimulation(preparedPlan.value)
        if (!ok) {
          return
        }
      }

      const reviewBorrowAmount = trimTrailingZeros(formatUnits(debtAmount, Number(multiplyShortVault.value.asset.decimals)))
      const reviewSwapToAmount = quote
        ? trimTrailingZeros(formatUnits(BigInt(quote.amountOut || 0), Number(multiplyLongVault.value.asset.decimals)))
        : undefined

      modal.open(OperationReviewModal, {
        props: {
          type: 'borrow',
          asset: multiplyShortVault.value.asset,
          amount: reviewBorrowAmount,
          prepared: preparedPlan.value || undefined,
          quoteFetchedAt: quote ? multiplyEffectiveQuoteFetchedAt.value : null,
          swapToAsset: quote ? multiplyLongVault.value.asset : undefined,
          swapToAmount: reviewSwapToAmount,
          swapMode: quote ? SwapperMode.EXACT_IN : undefined,
          subAccount,
          submittingLabel: 'Submitting...',
          onConfirm: async () => {
            await sendMultiply()
          },
        },
      })
    })
  }
  finally {
    isPreparing.value = false
  }
}

const sendMultiply = async () => {
  if (!preparedPlan.value) {
    return
  }
  isSubmitting.value = true
  try {
    await executePreparedPlan(preparedPlan.value)
    modal.close()
    refreshAllPositions(eulerLensAddresses.value, address.value || '')
    setTimeout(() => {
      router.replace({ path: '/portfolio', query: { network: route.query.network } })
    }, 400)
  }
  catch (e) {
    console.warn(e)
    error('Transaction failed')
  }
  finally {
    isSubmitting.value = false
  }
}

const isMultiplySubmitDisabled = computed(() => {
  if (!isConnected.value) return false
  if (!multiplySupplyVault.value || !multiplyLongVault.value || !multiplyShortVault.value) {
    return true
  }
  if (multiplyDebtAmountNano.value <= 0n) {
    return true
  }
  if (multiplyErrorText.value) {
    return true
  }
  const isSameAsset = normalizeAddress(multiplyLongVault.value.asset.address) === normalizeAddress(multiplyShortVault.value.asset.address)
  if (!isSameAsset && !multiplySelectedQuote.value) {
    return true
  }
  return false
})
const isGeoBlocked = computed(() => {
  const addresses: string[] = []
  if (multiplyLongVault.value) addresses.push(multiplyLongVault.value.address)
  if (multiplyShortVault.value) addresses.push(multiplyShortVault.value.address)
  return isAnyVaultBlockedByCountry(...addresses)
})
const isMultiplyRestricted = computed(() => {
  const long = multiplyLongVault.value
  const short = multiplyShortVault.value
  return (long && isVaultRestrictedByCountry(long.address))
    || (short && isVaultRestrictedByCountry(short.address))
})
const reviewMultiplyDisabled = computed(() => isGeoBlocked.value || isMultiplyRestricted.value || isMultiplySubmitDisabled.value)

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (isMultiplyRestricted.value) return { message: 'Multiply is not available for this pair in your region', variant: 'warning' }
  if (multiplyErrorText.value) return { message: multiplyErrorText.value, variant: 'error' }
  if (multiplySimulationError.value) return { message: multiplySimulationError.value, variant: 'error' }
  if (!multiplyIsSameAsset.value && isMultiplyQuoteLoading.value && multiplyDebtAmountNano.value > 0n) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (!multiplyIsSameAsset.value && !multiplySelectedQuote.value && multiplyDebtAmountNano.value > 0n) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})

const loadPosition = async () => {
  if (!isConnected.value && !isSpyMode.value) {
    position.value = null
    return
  }
  isLoading.value = true
  position.value = getPositionBySubAccountIndex(+positionIndex) || null
  if (!position.value) {
    multiplySupplyVault.value = undefined
    resetMultiplyQuoteState()
    isLoading.value = false
    return
  }
  multiplySupplyVault.value = multiplyLongVault.value
  isLoading.value = false
}

watch([isPositionsLoaded, () => route.params.number], ([loaded]) => {
  if (loaded) {
    loadPosition()
  }
}, { immediate: true })

watch([multiplySupplyVault, multiplyLongVault, multiplyShortVault], () => {
  clearMultiplySimulationError()
  resetMultiplyQuoteState()
  if (multiplyDebtAmountNano.value > 0n) {
    requestMultiplyQuote()
  }
})
watch(multiplySelectedQuote, () => {
  clearMultiplySimulationError()
})
watch(multiplySlippage, () => {
  clearMultiplySimulationError()
  if (multiplyDebtAmountNano.value <= 0n) {
    resetMultiplyQuoteState()
    return
  }
  requestMultiplyQuote()
})
watch([multiplyMinMultiplier, multiplyMaxMultiplier], ([min, max]) => {
  let next = multiplier.value
  if (!max || max < min) {
    next = min
  }
  else {
    if (next > max) {
      next = max
    }
    if (next < min) {
      next = min
    }
  }
  if (next !== multiplier.value) {
    multiplier.value = next
  }
  if (multiplyDebtAmountNano.value <= 0n) {
    resetMultiplyQuoteState()
    return
  }
  requestMultiplyQuote()
}, { immediate: true })
</script>

<template>
  <div class="relative">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="`/position/${positionIndex}`"
    />
    <VaultForm
      back
      :back-fallback="`/position/${positionIndex}`"
      title="Multiply"
      description="Increase your exposure by looping collateral through borrowing."
      :loading="isLoading || isPositionsLoading"
      class="flex flex-col gap-16 w-full"
      @submit.prevent="submitMultiply"
    >
      <template v-if="position && multiplySupplyVault && multiplyLongVault && multiplyShortVault">
        <VaultLabelsAndAssets
          :vault="multiplyLongVault"
          :assets="pairAssets"
          :assets-label="pairAssetsLabel"
          size="large"
        />
        <CorrelatedPairBadge
          v-if="isPairCorrelated"
          class="w-fit"
          :category="pairCorrelationCategory"
        />

        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <UiRange
              v-model="multiplier"
              label="Multiplier"
              :step="0.1"
              :min="multiplyMinMultiplier"
              :max="multiplyMaxMultiplier"
              :number-filter="(n: number) => `${formatNumber(n, 2, 0)}x`"
              @update:model-value="onMultiplierInput"
            />

            <SwapRouteSelector
              :items="multiplyRouteItems"
              :selected-provider="multiplySelectedProvider"
              :status-label="multiplyQuotesStatusLabel"
              :is-loading="isMultiplyQuoteLoading"
              :empty-message="multiplyRouteEmptyMessage"
              @select="selectMultiplyQuote"
              @refresh="onRefreshMultiplyQuotes"
            />

            <AssetInput
              v-model="multiplyLongAmount"
              :desc="multiplyLongProduct.name"
              label="Additional collateral"
              :asset="multiplyLongVault.asset"
              :vault="(multiplyLongVault as EVault)"
              :readonly="true"
            />

            <AssetInput
              v-model="multiplyShortAmount"
              :desc="multiplyShortProduct.name"
              label="Debt"
              :asset="multiplyShortVault.asset"
              :vault="multiplyShortVault"
              :readonly="true"
            />

            <UiAlert
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-if="!isGeoBlocked && isMultiplyRestricted"
              title="Asset restricted"
              description="Multiply is not available for this pair in your region."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-show="multiplyErrorText"
              title="Error"
              variant="error"
              :description="multiplyErrorText || ''"
              size="compact"
            />
            <UiAlert
              v-if="multiplySimulationError"
              title="Error"
              variant="error"
              :description="multiplySimulationError"
              size="compact"
            />

            <UiAlert
              v-if="multiplyQuoteError"
              title="Swap quote"
              variant="warning"
              :description="multiplyQuoteError"
              size="compact"
            />

            <VaultFormSubmit
              :disabled="reviewMultiplyDisabled"
              :loading="isSubmitting || isPreparing"
              :disabled-reason="disabledReasonInfo?.message"
              :disabled-reason-variant="disabledReasonInfo?.variant"
            >
              Review Multiply
            </VaultFormSubmit>
          </div>

          <VaultFormInfoBlock
            :loading="isMultiplyQuoteLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow
              v-if="isPairCorrelated"
              label="ROE"
            >
              <SummaryValue
                :before="multiplyRoeBefore !== null ? formatNumber(multiplyRoeBefore) : undefined"
                :after="multiplyRoeAfter !== null && multiplySwapReady ? formatNumber(multiplyRoeAfter) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow
              v-else
              label="Net APY"
            >
              <SummaryValue
                :before="multiplyNetApyBefore !== null ? formatNumber(multiplyNetApyBefore) : undefined"
                :after="multiplyNetApyAfter !== null && multiplySwapReady ? formatNumber(multiplyNetApyAfter) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow
              label="Swap price"
              align-top
            >
              <SummaryPriceValue
                :value="multiplyCurrentPrice ? formatSmartAmount(priceInvert.invertValue(multiplyCurrentPrice.value)) : undefined"
                :symbol="priceInvert.displaySymbol"
                invertible
                @invert="priceInvert.toggle"
              />
            </SummaryRow>
            <SummaryRow label="Liq. price">
              <SummaryPriceValue
                :before="multiplyCurrentLiquidationPrice !== null ? formatSmartAmount(priceInvert.invertValue(multiplyCurrentLiquidationPrice)) : undefined"
                :after="multiplyNextLiquidationPrice !== null && multiplySwapReady ? formatSmartAmount(priceInvert.invertValue(multiplyNextLiquidationPrice)) : undefined"
                :symbol="priceInvert.displaySymbol"
                invertible
                @invert="priceInvert.toggle"
              />
            </SummaryRow>
            <SummaryRow label="Liq. buffer">
              <SummaryValue
                :before="formatLiqBuffer(priceInvert.invertValue(multiplyPriceRatio), priceInvert.invertValue(multiplyCurrentLiquidationPrice))"
                :after="multiplyNextLiquidationPrice !== null && multiplySwapReady
                  ? formatLiqBuffer(priceInvert.invertValue(multiplyPriceRatio), priceInvert.invertValue(multiplyNextLiquidationPrice))
                  : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="LTV">
              <SummaryValue
                :before="multiplyCurrentLtv !== null ? formatNumber(multiplyCurrentLtv) : undefined"
                :after="multiplyNextLtv !== null && multiplySwapReady ? formatNumber(multiplyNextLtv) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="multiplyCurrentHealth !== null ? formatHealthScore(multiplyCurrentHealth) : undefined"
                :after="multiplyNextHealth !== null && multiplySwapReady ? formatHealthScore(multiplyNextHealth) : undefined"
              />
            </SummaryRow>
            <SwapDetailsSummary
              :input-display="multiplySwapSummary?.from ?? null"
              :output-display="multiplySwapSummary?.to ?? null"
              :price-impact="multiplyPriceImpact"
              :slippage="multiplySlippage"
              :routed-via="multiplyRoutedVia"
              :multiplied-price-impact="multipliedPriceImpact"
              @open-slippage-settings="openSlippageSettings"
            />
          </VaultFormInfoBlock>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
