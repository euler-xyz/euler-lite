<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getAddress, zeroAddress, type Address, type Abi } from 'viem'
import type { AccountBorrowPosition } from '~/entities/account'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import type {
  Vault,
  SecuritizeVault,
  VaultAsset,
} from '~/entities/vault'
import {
  getAssetUsdValue,
  getAssetOraclePrice,
  getCollateralOraclePrice,
  conservativePriceRatioNumber,
  getCollateralUsdValueOrZero,
} from '~/services/pricing/priceProvider'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { SwapperMode } from '~/entities/swap'
import type { SwapApiQuote } from '~/entities/swap'
import type { TxPlan } from '~/entities/txPlan'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer, calculateRoe } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'

const route = useRoute()
const { isConnected, address } = useAccount()
const { isSpyMode } = useSpyMode()
const { isPositionsLoaded, isPositionsLoading, getPositionBySubAccountIndex } = useEulerAccount()
const { buildSwapPlan, buildSameAssetSwapPlan } = useEulerOperations()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { isReady: isVaultsReady } = useVaults()
const { getOrFetch } = useVaultRegistry()
const { eulerLensAddresses, isReady: isEulerAddressesReady, loadEulerConfig } = useEulerAddresses()
const { client: rpcClient } = useRpcClient()

const positionIndex = usePositionIndex()

// ── Vaults & position ────────────────────────────────────────────────────
const position: Ref<AccountBorrowPosition | null> = ref(null)
const pairAssetsLabel = usePositionPairLabel(position)
const selectedCollateral = ref<Vault | SecuritizeVault | null>(null)
const selectedCollateralAssets = ref(0n)
const lastCollateralAddress = ref('')

const fromVault = computed(() => selectedCollateral.value || position.value?.collateral)
const borrowVault = computed(() => position.value?.borrow)
const toVault: Ref<Vault | undefined> = ref()
useOperationGuard(computed(() => [fromVault.value?.address, toVault.value?.address, borrowVault.value?.address].filter(Boolean)))

const isFromSecuritize = computed(() => fromVault.value && 'type' in fromVault.value && fromVault.value.type === 'securitize')
const fromVaultAsRegular = computed(() => {
  if (!fromVault.value || isFromSecuritize.value) return undefined
  return fromVault.value as Vault
})
const { collateralOptions, collateralVaults } = useSwapCollateralOptions({
  currentVault: fromVaultAsRegular,
  liabilityVault: computed(() => borrowVault.value as Vault | undefined),
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

// ── Shared swap logic (must be before any code that uses its outputs) ────
const swap = useSwapPageLogic({
  amountField: 'amountOut',
  compare: 'max',
  fromVault,
  toVault,
  balance,
  vaultOptions: swapTargetVaults,
  displayAmountField: 'amountOut',
  quoteDiffPrefix: '-',
  redirectPath: '/portfolio',
  targetVaultAddress,

  buildQuoteRequest(amount) {
    if (!fromVault.value || !toVault.value || !position.value) return null
    const account = (position.value.subAccount || address.value || zeroAddress) as Address
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
      },
    }
  },

  async buildPlan(): Promise<TxPlan> {
    if (!fromVault.value || !toVault.value || !position.value) throw new Error('Vaults or position not loaded')
    if (isSameAsset.value) {
      const amount = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
      return buildSameAssetSwapPlan({
        fromVaultAddress: fromVault.value.address,
        toVaultAddress: toVault.value.address,
        amount,
        isMax: isMaxSwap.value,
        subAccount: position.value.subAccount,
        enableCollateral: true,
        disableCollateral: isMaxSwap.value,
        liabilityVault: borrowVault.value?.address,
        enabledCollaterals: position.value.collaterals,
      })
    }
    if (!selectedQuote.value) throw new Error('No quote selected')
    return buildSwapPlan({
      quote: selectedQuote.value,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      requestedSlippage: slippage.value,
      targetDebt: 0n,
      currentDebt: 0n,
      enableCollateral: true,
      disableCollateral: isMaxSwap.value ? fromVault.value.address : undefined,
      liabilityVault: borrowVault.value?.address,
      enabledCollaterals: position.value.collaterals,
    })
  },

  getBalanceError: amountNano => balance.value < amountNano ? 'Not enough balance' : null,

  getGeoBlockedAddresses() {
    const addresses: string[] = []
    if (fromVault.value) addresses.push(fromVault.value.address)
    if (borrowVault.value) addresses.push(borrowVault.value.address)
    return addresses
  },

  async computePriceImpact(q: SwapApiQuote) {
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
  fromProduct, toProduct, swapPriceInvert, currentPrice, swapSummary, priceImpact, routedVia,
  swapRouteItems, swapRouteEmptyMessage,
  selectProvider, onFromInput, onRefreshQuotes, submit, openSlippageSettings,
  normalizeAddress, clearSimulationError, resetQuoteState,
} = swap

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
    selectedCollateralAssets.value = 0n
    return
  }

  const primaryAddress = normalizeAddress(position.value.collateral.address)
  const targetAddress = normalizeAddress(getSelectedCollateralAddress()) || primaryAddress

  if (targetAddress !== lastCollateralAddress.value) {
    fromAmount.value = ''
    lastCollateralAddress.value = targetAddress
    resetQuoteState()
  }

  selectedCollateralAssets.value = targetAddress === primaryAddress ? position.value.supplied : 0n

  try {
    if (!isEulerAddressesReady.value) {
      await loadEulerConfig()
    }

    await until(isVaultsReady).toBe(true)

    const vault = await getOrFetch(targetAddress) as Vault | SecuritizeVault | undefined
    selectedCollateral.value = vault || null

    const lensAddress = eulerLensAddresses.value?.accountLens
    if (!lensAddress) {
      throw new Error('Account lens address is not available')
    }

    const client = rpcClient.value!
    const res = await client.readContract({
      address: lensAddress as Address,
      abi: eulerAccountLensABI as Abi,
      functionName: 'getVaultAccountInfo',
      args: [position.value.subAccount, targetAddress],
    }) as { assets?: bigint }
    selectedCollateralAssets.value = res.assets ?? 0n
  }
  catch (e) {
    console.warn('[Collateral swap] failed to load collateral', e)
    if (!selectedCollateral.value) {
      selectedCollateral.value = position.value.collateral
    }
  }
}

const loadPosition = async () => {
  if (!isConnected.value && !isSpyMode.value) {
    position.value = null
    return
  }
  isLoading.value = true
  await until(isPositionsLoaded).toBe(true)

  position.value = getPositionBySubAccountIndex(+positionIndex) || null
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
  const base = nanoToValue(fromVault.value.interestRateInfo.supplyAPY || 0n, 25)
  return withIntrinsicSupplyApy(base, fromVault.value.asset.address) + getSupplyRewardApy(fromVault.value.address)
})
const toSupplyApy = computed(() => {
  if (!toVault.value) return null
  const base = nanoToValue(toVault.value.interestRateInfo.supplyAPY || 0n, 25)
  return withIntrinsicSupplyApy(base, toVault.value.asset.address) + getSupplyRewardApy(toVault.value.address)
})
const borrowApy = computed(() => {
  if (!borrowVault.value) return null
  const base = nanoToValue(borrowVault.value.interestRateInfo.borrowAPY || 0n, 25)
  return withIntrinsicBorrowApy(base, borrowVault.value.asset.address) - getBorrowRewardApy(borrowVault.value.address, fromVault.value?.address)
})

// ── Collateral USD valuation (from liability vault's perspective) ─────────
const getCollateralValueUsdLocal = async (amount: bigint) => {
  if (!borrowVault.value || !fromVault.value) return 0
  return getCollateralUsdValueOrZero(amount, borrowVault.value, fromVault.value as Vault, 'off-chain')
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
      return nanoToValue(valueToNano(fromAmount.value, toVault.value.asset.decimals), toVault.value.decimals)
    }
    catch { return null }
  }
  if (!quote.value || !toVault.value) return null
  return nanoToValue(BigInt(quote.value.amountOut), toVault.value.decimals)
})
const borrowAmount = computed(() => {
  if (!borrowVault.value || !position.value) return null
  return nanoToValue(position.value.borrowed, borrowVault.value.decimals)
})

const currentLtv = computed(() => position.value ? nanoToValue(position.value.userLTV, 18) : null)
const fromLiquidationLtv = computed(() => {
  if (!borrowVault.value || !fromVault.value) return null
  const match = borrowVault.value.collateralLTVs.find(
    ltv => normalizeAddress(ltv.collateral) === normalizeAddress(fromVault.value?.address),
  )
  return match ? nanoToValue(match.liquidationLTV, 2) : null
})
const nextLiquidationLtv = computed(() => {
  if (!borrowVault.value || !toVault.value) return null
  const match = borrowVault.value.collateralLTVs.find(
    ltv => normalizeAddress(ltv.collateral) === normalizeAddress(toVault.value?.address),
  )
  return match ? nanoToValue(match.liquidationLTV, 2) : null
})
// Remaining FROM collateral value after partial swap
const remainingFromValue = computed(() => {
  if (!fromVault.value || !fromAmount.value || !currentPriceRatio.value) return 0
  try {
    const swapped = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
    const remaining = selectedCollateralAssets.value - swapped
    if (remaining <= 0n) return 0
    return nanoToValue(remaining, fromVault.value.decimals) * currentPriceRatio.value
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
const currentHealth = computed(() => position.value ? nanoToValue(position.value.health, 18) : null)
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
  const collateralPrice = getCollateralOraclePrice(borrowVault.value, fromVault.value as Vault)
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
            <UiToast
              v-else-if="!isLoading && !isPositionsLoading"
              title="No collateral swap options"
              description="There are no other vaults that accept this collateral for this position."
              variant="warning"
              size="compact"
            />

            <UiToast
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-show="errorText"
              title="Error"
              variant="error"
              :description="errorText || ''"
              size="compact"
            />
            <UiToast
              v-if="toVault && sameVaultError"
              title="Error"
              variant="error"
              :description="sameVaultError"
              size="compact"
            />
            <UiToast
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <UiToast
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
