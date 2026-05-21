<script setup lang="ts">
import { formatUnits, zeroAddress, type Address } from 'viem'
import type { AccountBorrowPosition } from '~/entities/account'
import type { Vault, VaultAsset } from '~/entities/vault'
import { getAssetUsdValue, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatioNumber } from '~/services/pricing/priceProvider'
import { useSwapDebtOptions } from '~/composables/useSwapDebtOptions'
import { type SwapApiQuote, SwapperMode } from '~/entities/swap'
import type { TxPlan } from '~/entities/txPlan'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer, calculateRoe } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'

const route = useRoute()
const { isConnected, address } = useWagmi()
const { isSpyMode } = useSpyMode()
const { isPositionsLoaded, isPositionsLoading, getPositionBySubAccountIndex } = useEulerAccount()
const { buildSwapPlan, buildSameAssetDebtSwapPlan } = useEulerOperations()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()

const positionIndex = usePositionIndex()

// ── Position & vaults ────────────────────────────────────────────────────
const position: Ref<AccountBorrowPosition | null> = ref(null)

const pairAssetsLabel = usePositionPairLabel(position)
const fromVault = computed(() => position.value?.borrow)
const collateralVault = computed(() => position.value?.collateral)
const toVault: Ref<Vault | undefined> = ref()
useOperationGuard(computed(() => [fromVault.value?.address, toVault.value?.address, collateralVault.value?.address].filter(Boolean)))

const { borrowOptions, borrowVaults } = useSwapDebtOptions({
  collateralVault: computed(() => collateralVault.value as Vault | undefined),
  currentBorrowVault: computed(() => fromVault.value as Vault | undefined),
})

const currentDebt = computed(() => position.value?.borrowed || 0n)
const balance = computed(() => currentDebt.value)
const targetVaultAddress = computed(() => typeof route.query.to === 'string' ? route.query.to : '')
const _hasBorrowSwapOptions = computed(() => borrowVaults.value.length > 0)

const setFromAmountToMax = () => {
  if (!fromVault.value) {
    fromAmount.value = ''
    return
  }
  const exact = formatUnits(currentDebt.value, Number(fromVault.value.decimals))
  const [intPart, decPart = ''] = exact.split('.')
  const sigDigitsInInt = intPart.replace(/^0+/, '').length
  if (sigDigitsInInt >= 6) {
    fromAmount.value = intPart
  }
  else {
    const decLen = Math.max(0, 6 - sigDigitsInInt)
    fromAmount.value = decPart.length > 0
      ? `${intPart}.${decPart.slice(0, decLen)}`
      : intPart
  }
}

// ── APY & ROE ────────────────────────────────────────────────────────────
const liqPriceInvert = usePriceInvert(
  () => collateralVault.value?.asset.symbol,
  () => toVault.value?.asset.symbol,
)
const currentLiqDisplaySymbol = computed(() => {
  const a = collateralVault.value?.asset.symbol || ''
  const b = fromVault.value?.asset.symbol || ''
  return liqPriceInvert.isInverted ? `${b}/${a}` : `${a}/${b}`
})

const collateralSupplyApy = computed(() => {
  if (!collateralVault.value) return null
  const base = nanoToValue(collateralVault.value.interestRateInfo.supplyAPY || 0n, 25)
  return withIntrinsicSupplyApy(base, collateralVault.value.asset.address) + getSupplyRewardApy(collateralVault.value.address)
})
const fromBorrowApy = computed(() => {
  if (!fromVault.value) return null
  const base = nanoToValue(fromVault.value.interestRateInfo.borrowAPY || 0n, 25)
  return withIntrinsicBorrowApy(base, fromVault.value.asset.address) - getBorrowRewardApy(fromVault.value.address, collateralVault.value?.address)
})
const toBorrowApy = computed(() => {
  if (!toVault.value) return null
  const base = nanoToValue(toVault.value.interestRateInfo.borrowAPY || 0n, 25)
  return withIntrinsicBorrowApy(base, toVault.value.asset.address) - getBorrowRewardApy(toVault.value.address, collateralVault.value?.address)
})

const supplyValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!collateralVault.value || !position.value) {
    supplyValueUsd.value = null
    return
  }
  supplyValueUsd.value = (await getAssetUsdValue(position.value.supplied, collateralVault.value, 'off-chain')) ?? null
})
const currentBorrowValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!fromVault.value || !position.value) {
    currentBorrowValueUsd.value = null
    return
  }
  currentBorrowValueUsd.value = (await getAssetUsdValue(position.value.borrowed, fromVault.value, 'off-chain')) ?? null
})
const nextBorrowValueUsd = ref<number | null>(null)

const roeBefore = computed(() => calculateRoe(supplyValueUsd.value, currentBorrowValueUsd.value, collateralSupplyApy.value, fromBorrowApy.value))
const roeAfter = computed(() => calculateRoe(supplyValueUsd.value, nextBorrowValueUsd.value, collateralSupplyApy.value, toBorrowApy.value))

// ── Health metrics ───────────────────────────────────────────────────────
const priceRatio = computed(() => {
  if (!collateralVault.value || !toVault.value) return null
  const collateralPrice = getCollateralOraclePrice(toVault.value, collateralVault.value)
  const borrowPrice = getAssetOraclePrice(toVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
const collateralAmount = computed(() => {
  if (!collateralVault.value || !position.value) return null
  return nanoToValue(position.value.supplied, collateralVault.value.decimals)
})
const nextBorrowAmount = computed(() => {
  if (!quote.value || !toVault.value) return null
  return nanoToValue(BigInt(quote.value.amountIn), toVault.value.decimals)
})

const currentLtv = computed(() => position.value ? nanoToValue(position.value.userLTV, 18) : null)
const _currentLiquidationLtv = computed(() => position.value ? nanoToValue(position.value.liquidationLTV, 2) : null)
const nextLiquidationLtv = computed(() => {
  if (!toVault.value || !collateralVault.value) return null
  const match = toVault.value.collateralLTVs.find(
    ltv => normalizeAddress(ltv.collateral) === normalizeAddress(collateralVault.value?.address),
  )
  return match ? nanoToValue(match.liquidationLTV, 2) : null
})
const nextLtv = computed(() => {
  if (!nextBorrowAmount.value || !collateralAmount.value || !priceRatio.value) return null
  if (priceRatio.value <= 0 || collateralAmount.value <= 0) return null
  return (nextBorrowAmount.value / (collateralAmount.value * priceRatio.value)) * 100
})
const currentHealth = computed(() => position.value ? nanoToValue(position.value.health, 18) : null)
const nextHealth = computed(() => {
  if (!nextLiquidationLtv.value || !nextLtv.value) return null
  if (nextLtv.value <= 0) return null
  return nextLiquidationLtv.value / nextLtv.value
})
const currentPriceRatio = computed(() => {
  if (!collateralVault.value || !fromVault.value) return null
  const collateralPrice = getCollateralOraclePrice(fromVault.value, collateralVault.value)
  const borrowPrice = getAssetOraclePrice(fromVault.value)
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

const healthError = computed(() => {
  if (!quote.value || nextHealth.value === null) return null
  if (!Number.isFinite(nextHealth.value)) return null
  return nextHealth.value <= 1 ? 'Swap would make position unhealthy' : null
})

// ── Shared swap logic ────────────────────────────────────────────────────
const swap = useSwapPageLogic({
  amountField: 'amountIn',
  compare: 'min',
  fromVault,
  toVault,
  balance,
  vaultOptions: borrowVaults,
  displayAmountField: 'amountIn',
  quoteDiffPrefix: '+',
  redirectPath: '/portfolio',
  targetVaultAddress,
  additionalErrors: [healthError],
  sameAssetModalType: 'swap',
  swapperMode: SwapperMode.TARGET_DEBT,
  reviewSwapEstimatedSide: 'output',

  buildQuoteRequest(amount) {
    if (!fromVault.value || !toVault.value || !position.value) return null
    if (amount > currentDebt.value) return null
    const accountIn = (address.value || zeroAddress) as Address
    const accountOut = (position.value.subAccount || accountIn) as Address
    return {
      params: {
        tokenIn: toVault.value.asset.address as Address,
        tokenOut: fromVault.value.asset.address as Address,
        accountIn,
        accountOut,
        amount,
        vaultIn: toVault.value.address as Address,
        receiver: fromVault.value.address as Address,
        slippage: slippage.value,
        swapperMode: SwapperMode.TARGET_DEBT,
        isRepay: true,
        targetDebt: 0n,
        currentDebt: currentDebt.value,
      },
    }
  },

  async buildPlan(quote?: SwapApiQuote): Promise<TxPlan> {
    if (!fromVault.value || !toVault.value) throw new Error('Vaults not loaded')
    if (isSameAsset.value) {
      const amount = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
      return buildSameAssetDebtSwapPlan({
        oldVaultAddress: fromVault.value.address,
        newVaultAddress: toVault.value.address,
        amount,
        subAccount: position.value?.subAccount || address.value!,
        enabledCollaterals: position.value?.collaterals,
      })
    }
    const swapQuote = quote || selectedQuote.value
    if (!swapQuote) throw new Error('No quote selected')
    return buildSwapPlan({
      quote: swapQuote,
      swapperMode: SwapperMode.TARGET_DEBT,
      isRepay: true,
      requestedSlippage: slippage.value,
      isDebtSwap: true,
      targetDebt: 0n,
      currentDebt: currentDebt.value,
      liabilityVault: fromVault.value.address,
      enabledCollaterals: position.value?.collaterals,
    })
  },

  getBalanceError(amountNano) {
    if (!fromAmount.value) return null
    return amountNano > currentDebt.value ? 'Amount exceeds current debt' : null
  },

  getGeoBlockedAddresses() {
    const addresses: string[] = []
    if (fromVault.value) addresses.push(fromVault.value.address)
    if (collateralVault.value) addresses.push(collateralVault.value.address)
    return addresses
  },
})

const {
  isLoading, isSubmitting, isPreparing, fromAmount, toAmount, slippage,
  isSameAsset, sameVaultError, errorText, quote,
  isGeoBlocked, reviewSwapDisabled, reviewSwapLabel, simulationError,
  isQuoteLoading, quoteError, quotesStatusLabel, selectedProvider, selectedQuote,
  fromProduct, toProduct, swapPriceInvert, currentPrice, swapSummary, priceImpact, routedVia,
  swapRouteItems, swapRouteEmptyMessage,
  selectProvider, onFromInput: _onFromInput, onRefreshQuotes, submit, openSlippageSettings,
  normalizeAddress, clearSimulationError, requestQuote,
} = swap

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (errorText.value) return { message: errorText.value, variant: 'error' }
  if (sameVaultError.value) return { message: sameVaultError.value, variant: 'error' }
  if (healthError.value) return { message: healthError.value, variant: 'error' }
  if (quoteError.value) return { message: quoteError.value, variant: 'warning' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  if (!isSameAsset.value && isQuoteLoading.value && +fromAmount.value > 0) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (!isSameAsset.value && !selectedQuote.value && +fromAmount.value > 0) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})

// Must be after `swap` destructuring so `quote` is in scope
watchEffect(async () => {
  if (!quote.value || !toVault.value) {
    nextBorrowValueUsd.value = null
    return
  }
  nextBorrowValueUsd.value = (await getAssetUsdValue(BigInt(quote.value.amountIn), toVault.value, 'off-chain')) ?? null
})

// ── Position loading ─────────────────────────────────────────────────────
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
  if (loaded) {
    loadPosition()
  }
}, { immediate: true })

// ── Debt auto-fill ───────────────────────────────────────────────────────
watch([currentDebt, fromVault], () => {
  clearSimulationError()
  if (!position.value) return
  setFromAmountToMax()
  if (toVault.value) {
    requestQuote()
  }
})

watch(borrowVaults, (vaults) => {
  if (!toVault.value) return
  const existsInOptions = vaults.some(v => normalizeAddress(v.address) === normalizeAddress(toVault.value?.address))
  if (!existsInOptions) {
    toVault.value = undefined
  }
})

const onToVaultChange = (selectedIndex: number) => {
  clearSimulationError()
  const nextVault = borrowVaults.value[selectedIndex]
  if (!nextVault) return
  if (!toVault.value || normalizeAddress(toVault.value.address) !== normalizeAddress(nextVault.address)) {
    toVault.value = nextVault
  }
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
      title="Refinance debt"
      description="Move your debt to a different vault, potentially for a better rate."
      class="flex flex-col gap-16 w-full"
      :loading="isLoading || isPositionsLoading"
      @submit.prevent="submit"
    >
      <template v-if="fromVault">
        <VaultLabelsAndAssets
          :vault="fromVault"
          :assets="[fromVault.asset] as VaultAsset[]"
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
              :readonly="true"
              class="opacity-60 pointer-events-none"
            />

            <UiAlert
              title="Full amount required"
              description="The entire debt amount must be swapped at once. Only one debt is allowed per sub-account."
              variant="info"
              size="compact"
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
              :collateral-options="borrowOptions"
              collateral-modal-title="Select debt"
              collateral-modal-apy-label="Borrow APY"
              :readonly="true"
              @change-collateral="onToVaultChange"
            />
            <div
              v-else
              class="flex flex-col gap-12 p-16 rounded-16 border bg-[var(--ui-form-field-background)] border-[var(--ui-form-field-border-color)] shadow-[var(--ui-form-field-shadow)] opacity-60"
            >
              <div class="flex justify-between text-content-tertiary">
                <p>To</p>
              </div>
              <div class="flex items-center gap-12">
                <span class="text-h1 text-content-tertiary w-full h-40 flex items-center">0.00</span>
              </div>
            </div>

            <UiAlert
              v-if="!toVault && !isLoading && !isPositionsLoading"
              title="No refinance options"
              description="There are no other vaults that accept this collateral to swap your debt to."
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
              v-show="errorText"
              title="Error"
              variant="error"
              :description="errorText || ''"
              size="compact"
            />
            <UiAlert
              v-if="sameVaultError"
              title="Error"
              variant="error"
              :description="sameVaultError"
              size="compact"
            />
            <UiAlert
              v-if="healthError"
              title="Unhealthy position"
              variant="error"
              :description="healthError"
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
              v-if="quoteError && !isSameAsset"
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
                :disabled="reviewSwapDisabled"
                :loading="isSubmitting || isPreparing"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
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
            <SummaryRow label="ROE">
              <SummaryValue
                :before="roeBefore !== null ? formatNumber(roeBefore) : undefined"
                :after="roeAfter !== null && quote ? formatNumber(roeAfter) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow
              v-if="!isSameAsset"
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
            <SummaryRow
              label="Liq. price"
              align-top
            >
              <!-- Borrow swap changes the borrow vault, so before/after symbols may differ -->
              <p class="text-p2 text-right inline-flex items-center flex-wrap justify-end gap-x-4">
                <template v-if="currentLiquidationPrice !== null && nextLiquidationPrice !== null && quote">
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
                :after="nextLiquidationPrice !== null && quote
                  ? formatLiqBuffer(liqPriceInvert.invertValue(priceRatio), liqPriceInvert.invertValue(nextLiquidationPrice))
                  : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="LTV">
              <SummaryValue
                :before="currentLtv !== null ? formatNumber(currentLtv) : undefined"
                :after="nextLtv !== null && quote ? formatNumber(nextLtv) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="currentHealth !== null ? formatHealthScore(currentHealth) : undefined"
                :after="nextHealth !== null && quote ? formatHealthScore(nextHealth) : undefined"
              />
            </SummaryRow>
            <SwapDetailsSummary
              v-if="!isSameAsset"
              :input-display="swapSummary?.from ?? null"
              :input-exact-display="swapSummary?.fromExact ?? null"
              :output-display="swapSummary?.to ?? null"
              :output-exact-display="swapSummary?.toExact ?? null"
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
