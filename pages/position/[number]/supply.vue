<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import type { SwapTokenSelectMeta } from '~/components/entities/asset/SwapTokenSelector.vue'
import { getCollateralOraclePrice, getAssetOraclePrice, conservativePriceRatio, getTokenUsdPrice } from '~/utils/sdk-prices'
import type { SwapQuote, EVault } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useCollateralForm } from '~/composables/position/useCollateralForm'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { getAddress, type Address, zeroAddress } from 'viem'
import { isNativeCurrencyAddress, isNativeOfWrapped, resolveWrappedNativeAddress, resolveWrappedNativeAsset } from '~/utils/native-currency'
import { FixedPoint } from '~/utils/fixed-point'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'

const positionIndex = usePositionIndex()
const { isConnected, address } = useWagmi()
const { isSpyMode } = useSpyMode()
const { fetchSingleBalance } = useWallets()
const { planDeposit, planDepositWithSwap } = useEulerTx()
const { chainId } = useEulerAddresses()
// Page uses SwapTokenSelector — opt into full wallet-token balance fetch while mounted.
useFullBalances()

// Supply-specific state
const balance = ref(0n)
const selectedAsset = ref<VaultAsset | undefined>()
const selectedAssetBalance = ref(0n)
const swapAssetUsdPrice = ref<number | undefined>()
const isUnknownSwapToken = ref(false)

const needsSwap = computed(() => {
  if (!selectedAsset.value || !form.asset.value) return false
  try {
    if (isNativeOfWrapped(selectedAsset.value.address, form.asset.value.address, chainId.value!)) return false
    return getAddress(selectedAsset.value.address) !== getAddress(form.asset.value.address)
  }
  catch {
    return false
  }
})
const isNativeWrap = computed(() => {
  if (!selectedAsset.value || !form.asset.value) return false
  return isNativeOfWrapped(selectedAsset.value.address, form.asset.value.address, chainId.value!)
})

const activeBalance = computed(() => (needsSwap.value || isNativeWrap.value) ? selectedAssetBalance.value : balance.value)
const activeAsset = computed(() => (needsSwap.value || isNativeWrap.value) && selectedAsset.value ? selectedAsset.value : form.asset.value)

const form = useCollateralForm({
  mode: 'supply',
  needsSwap,
  effectiveBalance: activeBalance,
  effectiveAsset: activeAsset,

  computePriceFixed: (_pos, borrowVault, collateralVault) => {
    const collateralPrice = borrowVault && collateralVault
      ? getCollateralOraclePrice(borrowVault, collateralVault)
      : undefined
    const borrowPrice = borrowVault ? getAssetOraclePrice(borrowVault) : undefined
    return FixedPoint.fromValue(conservativePriceRatio(collateralPrice, borrowPrice), 18)
  },

  computeLiquidationPrice: (pos, borrowVault, collateralVault) => {
    const healthValue = pos.healthFactor
    if (healthValue === undefined) return undefined
    const health = nanoToValue(healthValue, 18)
    if (health < 1) return undefined
    const cp = borrowVault && collateralVault ? getCollateralOraclePrice(borrowVault, collateralVault) : undefined
    const bp = borrowVault ? getAssetOraclePrice(borrowVault) : undefined
    const ratio = nanoToValue(conservativePriceRatio(cp, bp), 18)
    if (!ratio) return undefined
    return ratio / health
  },

  validateEstimate: ({ amountFixed, needsSwap: isSwap }) => {
    if (!isSwap && !isNativeWrap.value && balanceFixed.value.lt(amountFixed)) {
      throw new Error('Not enough balance')
    }
    if ((isSwap || isNativeWrap.value) && selectedAssetBalance.value < valueToNano(form.amount.value, selectedAsset.value?.decimals)) {
      throw new Error('Not enough balance')
    }
  },

  buildDirectPlan: async ({ vaultAddress, assetAddress, amountNano, subAccount }) => {
    const wrappedAddr = isNativeWrap.value ? resolveWrappedNativeAddress(chainId.value!) : null
    if (isNativeWrap.value && !wrappedAddr) {
      throw new Error('Wrapped native token not found')
    }
    return planDeposit({
      vaultAddress: vaultAddress as Address,
      assetAddress: assetAddress as Address,
      amount: amountNano,
      receiver: subAccount as Address,
      wrappedNativeInfo: isNativeWrap.value && wrappedAddr
        ? { wrappedTokenAddress: wrappedAddr, nativeAmount: amountNano }
        : undefined,
    })
  },

  buildSwapPlan: async (quote: SwapQuote) => {
    if (!selectedAsset.value || !form.collateralVault.value) {
      throw new Error('No selected asset or vault')
    }
    const isNative = isNativeCurrencyAddress(selectedAsset.value.address)
    const inputAmount = valueToNano(form.amount.value || '0', selectedAsset.value.decimals)
    const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
    if (isNative && !wrappedAddress) {
      throw new Error('Wrapped native token not found')
    }
    return planDepositWithSwap({
      swapQuote: quote,
      amount: inputAmount,
      tokenIn: (wrappedAddress || selectedAsset.value.address) as Address,
      wrappedNativeInfo: isNative && wrappedAddress
        ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
        : undefined,
    })
  },

  requestSwapQuoteParams: ({ userAddr, subAccountAddr, amountNano: _amountNano, slippage }) => {
    if (!selectedAsset.value || !form.asset.value || !form.collateralVault.value) return null
    const isNative = isNativeCurrencyAddress(selectedAsset.value.address)
    const swapTokenIn = isNative
      ? resolveWrappedNativeAddress(chainId.value!)
      : selectedAsset.value.address
    if (!swapTokenIn) return null
    return {
      tokenIn: swapTokenIn as Address,
      tokenOut: form.asset.value.address as Address,
      accountIn: zeroAddress as Address,
      accountOut: subAccountAddr,
      amount: valueToNano(form.amount.value || '0', selectedAsset.value.decimals),
      vaultIn: zeroAddress as Address,
      receiver: form.collateralVault.value.address as Address,
      unusedInputReceiver: userAddr,
      slippage,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      targetDebt: 0n,
      currentDebt: 0n,
    }
  },

  getSwapOutputAsset: () => form.asset.value,

  reviewLabel: 'Review Supply',
  reviewType: 'supply',
  swapReviewType: 'swap-supply',
  getReviewAsset: (isSwap) => {
    if (isSwap && selectedAsset.value) {
      if (isNativeCurrencyAddress(selectedAsset.value.address)) {
        return resolveWrappedNativeAsset(chainId.value!) || selectedAsset.value
      }
      return selectedAsset.value
    }
    return form.asset.value
  },
  getSwapToAsset: () => form.asset.value,

  onAfterLoad: () => updateBalance(),
})
useOperationGuard(computed(() => [form.collateralVault.value?.address].filter(Boolean)))

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (form.isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (form.isInputAssetBlocked.value) return { message: 'Paying with this asset is not available in your region', variant: 'warning' }
  if (form.isSwapRestricted.value) return { message: 'Swapping into this vault is not available in your region', variant: 'warning' }
  if (form.estimatesError.value) return { message: form.estimatesError.value, variant: 'error' }
  if (form.simulationError.value) return { message: form.simulationError.value, variant: 'error' }
  if (needsSwap.value && form.isSwapQuoteLoading.value && +form.amount.value > 0) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (needsSwap.value && !form.swapSelectedQuote.value && +form.amount.value > 0) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})

const balanceFixed = computed(() => FixedPoint.fromValue(balance.value, form.collateralVault.value?.asset.decimals || 18))
const assets = computed(() => [form.asset.value].filter((v): v is VaultAsset => !!v))
const pairAssetsLabel = usePositionPairLabel(form.position)
const { name } = useEulerProductOfVault(computed(() => form.collateralVault.value?.address || ''))

// Supply-specific: balance management
const updateBalance = async () => {
  if ((!isConnected.value && !isSpyMode.value) || !form.collateralVault.value?.asset.address) {
    balance.value = 0n
    return
  }
  balance.value = await fetchSingleBalance(form.collateralVault.value.asset.address)
}

const fetchSelectedAssetBalance = async () => {
  if (!selectedAsset.value?.address) {
    selectedAssetBalance.value = 0n
    return
  }
  selectedAssetBalance.value = await fetchSingleBalance(selectedAsset.value.address)
}

const onSelectSwapAsset = (newAsset: VaultAsset, meta?: SwapTokenSelectMeta) => {
  selectedAsset.value = newAsset
  isUnknownSwapToken.value = meta?.isUnknownToken ?? false
  form.amount.value = ''
  form.clearSimulationError()
  form.resetSwapQuoteState()
}

const openSwapTokenSelector = () => {
  form.openSwapTokenSelector(
    selectedAsset.value?.address || form.asset.value?.address,
    onSelectSwapAsset,
  )
}

// Supply-specific watchers
watch(isConnected, () => {
  updateBalance()
})

watch(address, () => {
  updateBalance()
  fetchSelectedAssetBalance()
})

watch(selectedAsset, async () => {
  fetchSelectedAssetBalance()
  if (needsSwap.value && form.amount.value) {
    form.resetSwapQuoteState()
    form.requestSwapQuote()
  }
  if (selectedAsset.value?.address && (needsSwap.value || isNativeWrap.value)) {
    const priceAddr = isNativeCurrencyAddress(selectedAsset.value.address)
      ? resolveWrappedNativeAddress(chainId.value!) || selectedAsset.value.address
      : selectedAsset.value.address
    swapAssetUsdPrice.value = await getTokenUsdPrice(priceAddr as Address)
  }
  else {
    swapAssetUsdPrice.value = undefined
  }
})
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
      title="Supply collateral"
      description="Add collateral to improve your health score and reduce liquidation risk."
      :loading="form.isLoading.value"
      @submit.prevent="form.submit"
    >
      <div v-if="!isConnected && !isSpyMode">
        Connect your wallet to see your positions
      </div>

      <template v-else-if="form.collateralVault.value">
        <VaultLabelsAndAssets
          :vault="form.collateralVault.value"
          :assets="assets"
          :assets-label="pairAssetsLabel"
          size="large"
        />

        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-if="form.asset.value"
              v-model="form.amount.value"
              label="Supply amount"
              :desc="name"
              :asset="(needsSwap || isNativeWrap) && selectedAsset ? selectedAsset : form.asset.value"
              :vault="(needsSwap || isNativeWrap) ? undefined : (form.collateralVault.value as EVault)"
              :price-override="(needsSwap || isNativeWrap) ? swapAssetUsdPrice : undefined"
              :balance="activeBalance"
              maxable
            />

            <!-- Pay with token selector -->
            <div class="flex items-center gap-8">
              <span class="text-p3 text-content-tertiary">Pay with</span>
              <button
                type="button"
                class="flex items-center gap-6 bg-card text-p3 font-semibold px-12 h-36 rounded-[40px] whitespace-nowrap"
                @click="openSwapTokenSelector"
              >
                <AssetAvatar
                  :asset="{ address: selectedAsset?.address || form.asset.value?.address || '', symbol: selectedAsset?.symbol || form.asset.value?.symbol || '' }"
                  size="20"
                />
                {{ selectedAsset?.symbol || form.asset.value?.symbol }}
                <SvgIcon
                  class="text-content-tertiary !w-16 !h-16"
                  name="arrow-down"
                />
              </button>
            </div>

            <!-- Swap info block -->
            <template v-if="needsSwap && form.asset.value">
              <SwapRouteSelector
                :items="form.swapRouteItems.value"
                :selected-provider="form.swapSelectedProvider.value"
                :status-label="form.swapQuotesStatusLabel.value"
                :is-loading="form.isSwapQuoteLoading.value"
                empty-message="Enter amount to fetch quotes"
                @select="form.selectSwapQuote"
                @refresh="form.onRefreshSwapQuotes"
              />

              <VaultFormInfoBlock
                v-if="form.swapEstimatedOutput.value || form.swapQuoteError.value"
                :loading="form.isSwapQuoteLoading.value"
                variant="card"
              >
                <SwapDetailsSummary
                  :input-display="form.swapInputDisplay.value"
                  :output-display="form.swapOutputDisplay.value"
                  :price-impact="form.swapPriceImpact.value"
                  :slippage="form.swapSlippage.value"
                  :routed-via="form.swapRoutedVia.value"
                  @open-slippage-settings="form.openSlippageSettings"
                />
              </VaultFormInfoBlock>

              <UiToast
                v-if="form.swapQuoteError.value"
                title="Swap quote"
                variant="warning"
                :description="form.swapQuoteError.value"
                size="compact"
              />
            </template>

            <UiToast
              v-if="isUnknownSwapToken && needsSwap"
              title="Unknown token"
              description="This token is not on any recognized token list. It could be fraudulent or malicious. Verify the contract address before proceeding."
              variant="warning"
              size="compact"
            />

            <UiToast
              v-if="form.isGeoBlocked.value"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="!form.isGeoBlocked.value && form.isInputAssetBlocked.value"
              title="Asset restricted"
              description="Paying with this asset is not available in your region. Pick a different token."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="!form.isGeoBlocked.value && !form.isInputAssetBlocked.value && form.isSwapRestricted.value"
              title="Swap restricted"
              description="Swapping into this vault is not available in your region. You can deposit the vault's underlying asset directly."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-show="form.estimatesError.value"
              title="Error"
              variant="error"
              :description="form.estimatesError.value"
              size="compact"
            />
            <UiToast
              v-if="form.simulationError.value"
              title="Error"
              variant="error"
              :description="form.simulationError.value"
              size="compact"
            />
            <VaultWarningBanner :warnings="[form.hookWarning.value]" />
          </div>

          <VaultFormInfoBlock
            v-if="form.position.value"
            :loading="form.isEstimatesLoading.value"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow label="Net APY">
              <SummaryValue
                :before="formatNumber(form.netAPY.value)"
                :after="formatNumber(form.estimateNetAPY.value)"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Oracle price">
              <SummaryPriceValue
                :value="!form.priceFixed.value.isZero() ? formatSmartAmount(form.priceInvert.invertValue(form.priceFixed.value.toUnsafeFloat())) : undefined"
                :symbol="form.priceInvert.displaySymbol"
                invertible
                @invert="form.priceInvert.toggle"
              />
            </SummaryRow>
            <SummaryRow label="Liq. price">
              <SummaryPriceValue
                :before="form.liquidationPrice.value != null && form.liquidationPrice.value !== Infinity ? formatSmartAmount(form.priceInvert.invertValue(form.liquidationPrice.value)!) : undefined"
                :after="form.estimateLiquidationPrice.value != null ? formatSmartAmount(form.priceInvert.invertValue(form.estimateLiquidationPrice.value)!) : undefined"
                :symbol="form.priceInvert.displaySymbol"
                invertible
                @invert="form.priceInvert.toggle"
              />
            </SummaryRow>
            <SummaryRow label="Liq. buffer">
              <SummaryValue
                :before="formatLiqBuffer(form.priceInvert.invertValue(form.priceFixed.value.toUnsafeFloat()), form.priceInvert.invertValue(form.liquidationPrice.value))"
                :after="formatLiqBuffer(form.priceInvert.invertValue(form.priceFixed.value.toUnsafeFloat()), form.priceInvert.invertValue(form.estimateLiquidationPrice.value))"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="LTV">
              <SummaryValue
                :before="formatNumber(nanoToValue(form.position.value.userLTV ?? form.position.value.currentLTV ?? 0n, 18))"
                :after="formatNumber(nanoToValue(form.estimateUserLTV.value, 18))"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="formatHealthScore(nanoToValue(form.position.value.healthFactor ?? 0n, 18))"
                :after="formatHealthScore(nanoToValue(form.estimateHealth.value, 18))"
              />
            </SummaryRow>
          </VaultFormInfoBlock>

          <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
            <VaultFormInfoButton
              :disabled="form.isLoading.value || form.isSubmitting.value"
              :vault="form.collateralVault.value"
            />
            <VaultFormSubmit
              :disabled="form.submitDisabled.value"
              :loading="form.isSubmitting.value || form.isPreparing.value"
              :disabled-reason="disabledReasonInfo?.message"
              :disabled-reason-variant="disabledReasonInfo?.variant"
            >
              {{ form.submitLabel }}
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
