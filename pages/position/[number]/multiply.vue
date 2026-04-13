<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { formatUnits, type Address } from 'viem'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { OperationReviewModal, SlippageSettingsModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { AccountBorrowPosition } from '~/entities/account'
import type { Vault, VaultAsset } from '~/entities/vault'
import { getAssetUsdValue, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatioNumber } from '~/services/pricing/priceProvider'
import { computeMultipliedPriceImpact } from '~/utils/priceImpact'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { type SwapApiQuote, SwapperMode } from '~/entities/swap'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import type { TxPlan } from '~/entities/txPlan'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { formatNumber, formatSmartAmount, formatHealthScore, trimTrailingZeros } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer, calculateRoe, computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import { computeMaxMultiplier } from '~/utils/multiply-math'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'

const route = useRoute()
const router = useRouter()
const modal = useModal()
const { error } = useToast()
const { address, isConnected } = useAccount()
const { isSpyMode } = useSpyMode()
const { isPositionsLoading, isPositionsLoaded, refreshAllPositions, getPositionBySubAccountIndex } = useEulerAccount()
const { buildMultiplyPlan, executeTxPlan } = useEulerOperations()
const { eulerLensAddresses } = useEulerAddresses()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
const {
  runSimulation: runMultiplySimulation,
  simulationError: multiplySimulationError,
  clearSimulationError: clearMultiplySimulationError,
} = useTxPlanSimulation()
const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

type MultiplyPlanParams = {
  supplyVaultAddress: string
  supplyAssetAddress: string
  supplyAmount: bigint
  supplySharesAmount?: bigint
  supplyIsSavings?: boolean
  longVaultAddress: string
  longAssetAddress: string
  borrowVaultAddress: string
  debtAmount: bigint
  quote?: SwapApiQuote
  swapperMode: SwapperMode
  subAccount: string
}

const priceInvert = usePriceInvert(
  () => multiplyShortVault.value?.asset.symbol,
  () => multiplyLongVault.value?.asset.symbol,
)

const positionIndex = usePositionIndex()
const position: Ref<AccountBorrowPosition | null> = ref(null)

const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const plan = ref<TxPlan | null>(null)
const planParams = ref<MultiplyPlanParams | null>(null)

const multiplier = ref(1)
const multiplyLongAmount = ref('')
const multiplyShortAmount = ref('')
const multiplySupplyVault: Ref<Vault | undefined> = ref()

const { slippage: multiplySlippage } = useSlippage({
  fromSymbol: () => position.value?.borrow.asset.symbol,
  toSymbol: () => position.value?.collateral.asset.symbol,
})
const {
  sortedQuoteCards: multiplyQuoteCardsSorted,
  selectedProvider: multiplySelectedProvider,
  selectedQuote: multiplySelectedQuote,
  effectiveQuote: multiplyEffectiveQuote,
  providersCount: multiplyProvidersCount,
  isLoading: isMultiplyQuoteLoading,
  quoteError: multiplyQuoteError,
  statusLabel: multiplyQuotesStatusLabel,
  getQuoteDiffPct,
  reset: resetMultiplyQuoteStateInternal,
  requestQuotes: requestMultiplyQuotes,
  selectProvider: selectMultiplyQuote,
} = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max' })

const multiplyLongVault = computed(() => position.value?.collateral)
const multiplyShortVault = computed(() => position.value?.borrow)
const multiplySubAccount = computed(() => position.value?.subAccount || null)
useOperationGuard(computed(() => [multiplySupplyVault.value?.address, multiplyLongVault.value?.address, multiplyShortVault.value?.address].filter(Boolean)))

const pairAssets = computed(() => {
  if (!multiplyLongVault.value || !multiplyShortVault.value) {
    return []
  }
  return [multiplyLongVault.value.asset, multiplyShortVault.value.asset]
})
const pairAssetsLabel = usePositionPairLabel(position)

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
  const base = nanoToValue(multiplySupplyVault.value.interestRateInfo.supplyAPY || 0n, 25)
  return withIntrinsicSupplyApy(base, multiplySupplyVault.value.asset.address) + getSupplyRewardApy(multiplySupplyVault.value.address)
})
const multiplyLongApy = computed(() => {
  if (!multiplyLongVault.value) {
    return null
  }
  const base = nanoToValue(multiplyLongVault.value.interestRateInfo.supplyAPY || 0n, 25)
  return withIntrinsicSupplyApy(base, multiplyLongVault.value.asset.address) + getSupplyRewardApy(multiplyLongVault.value.address)
})
const multiplyBorrowApy = computed(() => {
  if (!multiplyShortVault.value) {
    return null
  }
  const base = nanoToValue(multiplyShortVault.value.interestRateInfo.borrowAPY || 0n, 25)
  return withIntrinsicBorrowApy(base, multiplyShortVault.value.asset.address) - getBorrowRewardApy(multiplyShortVault.value.address, multiplySupplyVault.value?.address)
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
  const match = multiplyShortVault.value.collateralLTVs.find(
    ltv => normalizeAddress(ltv.collateral) === normalizeAddress(multiplySupplyVault.value?.address),
  )
  return match ? nanoToValue(match.borrowLTV, 2) : 0
})
const multiplyMaxMultiplier = computed(() => computeMaxMultiplier(multiplyBorrowLtv.value))
const multiplyCurrentMultiple = computed(() => {
  if (!position.value) {
    return 1
  }
  const ltvPercent = nanoToValue(position.value.userLTV, 18)
  if (!Number.isFinite(ltvPercent) || ltvPercent <= 0) {
    return 1
  }
  const ltv = ltvPercent / 100
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
const multiplyLiquidationLtv = computed(() => {
  if (!multiplySupplyVault.value || !multiplyShortVault.value) {
    return null
  }
  const match = multiplyShortVault.value.collateralLTVs.find(
    ltv => normalizeAddress(ltv.collateral) === normalizeAddress(multiplySupplyVault.value?.address),
  )
  return match ? nanoToValue(match.liquidationLTV, 2) : null
})
const multiplyCurrentLtv = computed(() => {
  if (!position.value) {
    return null
  }
  return nanoToValue(position.value.userLTV, 18)
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
  return nanoToValue(position.value.liquidationLTV, 2)
})
const multiplyNextLiquidationLtv = computed(() => {
  return multiplyLiquidationLtv.value ?? multiplyCurrentLiquidationLtv.value
})
const multiplyCurrentHealth = computed(() => {
  if (!position.value) {
    return null
  }
  return nanoToValue(position.value.health, 18)
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
})
const multiplyRoutedVia = computed(() => {
  if (isMultiplyQuoteLoading.value) {
    return null
  }
  if (!multiplyEffectiveQuote.value?.route?.length) {
    return null
  }
  return multiplyEffectiveQuote.value.route.map(route => route.providerName).join(', ')
})
const multiplyErrorText = computed(() => {
  if (!multiplyShortVault.value) {
    return null
  }
  if (multiplyDebtAmountNano.value > 0n && (multiplyShortVault.value.supply || 0n) < multiplyDebtAmountNano.value) {
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

      const nextPlanParams: MultiplyPlanParams = {
        supplyVaultAddress: multiplySupplyVault.value.address,
        supplyAssetAddress: multiplySupplyVault.value.asset.address,
        supplyAmount: 0n,
        longVaultAddress: multiplyLongVault.value.address,
        longAssetAddress: multiplyLongVault.value.asset.address,
        borrowVaultAddress: multiplyShortVault.value.address,
        debtAmount,
        quote: quote || undefined,
        swapperMode: SwapperMode.EXACT_IN,
        subAccount,
      }
      planParams.value = nextPlanParams

      try {
        plan.value = await buildMultiplyPlan({
          ...nextPlanParams,
          includePermit2Call: false,
          enabledCollaterals: position.value?.collaterals,
          enabledController: position.value?.borrow.address,
        })
      }
      catch (e) {
        console.warn('[Multiply] failed to build plan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runMultiplySimulation(plan.value)
        if (!ok) {
          return
        }
      }

      modal.open(OperationReviewModal, {
        props: {
          type: 'borrow',
          asset: multiplyShortVault.value.asset,
          amount: multiplyShortAmount.value || formatUnits(debtAmount, Number(multiplyShortVault.value.asset.decimals)),
          plan: plan.value || undefined,
          swapToAsset: quote ? multiplyLongVault.value.asset : undefined,
          swapToAmount: quote ? multiplyLongAmount.value : undefined,
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
  if (!planParams.value) {
    return
  }
  isSubmitting.value = true
  try {
    const nextPlan = await buildMultiplyPlan({
      ...planParams.value,
      includePermit2Call: true,
      enabledCollaterals: position.value?.collaterals,
      enabledController: position.value?.borrow.address,
    })
    plan.value = nextPlan
    await executeTxPlan(nextPlan)
    modal.close()
    refreshAllPositions(eulerLensAddresses.value, address.value || '')
    setTimeout(() => {
      router.replace('/portfolio')
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
  multiplySupplyVault.value = position.value.collateral as Vault
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
      class="hidden laptop:inline-flex laptop:absolute laptop:top-20 laptop:right-full laptop:mr-4"
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
          :assets="pairAssets as VaultAsset[]"
          :assets-label="pairAssetsLabel"
          size="large"
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
              label="Long"
              :asset="multiplyLongVault.asset"
              :vault="(multiplyLongVault as Vault)"
              :readonly="true"
            />

            <AssetInput
              v-model="multiplyShortAmount"
              :desc="multiplyShortProduct.name"
              label="Short"
              :asset="multiplyShortVault.asset"
              :vault="multiplyShortVault"
              :readonly="true"
            />

            <UiToast
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="!isGeoBlocked && isMultiplyRestricted"
              title="Asset restricted"
              description="Multiply is not available for this pair in your region."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-show="multiplyErrorText"
              title="Error"
              variant="error"
              :description="multiplyErrorText || ''"
              size="compact"
            />
            <UiToast
              v-if="multiplySimulationError"
              title="Error"
              variant="error"
              :description="multiplySimulationError"
              size="compact"
            />

            <UiToast
              v-if="multiplyQuoteError"
              title="Swap quote"
              variant="warning"
              :description="multiplyQuoteError"
              size="compact"
            />

            <VaultFormSubmit
              :disabled="reviewMultiplyDisabled"
              :loading="isSubmitting || isPreparing"
            >
              Review Multiply
            </VaultFormSubmit>
          </div>

          <VaultFormInfoBlock
            :loading="isMultiplyQuoteLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow label="ROE">
              <SummaryValue
                :before="multiplyRoeBefore !== null ? formatNumber(multiplyRoeBefore) : undefined"
                :after="multiplyRoeAfter !== null && multiplySwapReady ? formatNumber(multiplyRoeAfter) : undefined"
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
