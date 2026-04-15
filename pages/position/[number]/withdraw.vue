<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getAddress, type Address, zeroAddress } from 'viem'
import { FixedPoint } from '~/utils/fixed-point'
import type { Vault, VaultAsset } from '~/entities/vault'
import type { SwapTokenSelectMeta } from '~/components/entities/asset/SwapTokenSelector.vue'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import {
  getAssetOraclePrice,
  getCollateralOraclePrice,
  conservativePriceRatio,
} from '~/services/pricing/priceProvider'
import type { SwapApiQuote } from '~/entities/swap'
import { SwapperMode } from '~/entities/swap'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useCollateralForm } from '~/composables/position/useCollateralForm'

const positionIndex = usePositionIndex()
const { address } = useAccount()
const { buildWithdrawPlan, buildWithdrawAndSwapPlan } = useEulerOperations()
const { refreshAllPositions } = useEulerAccount()
const { eulerLensAddresses } = useEulerAddresses()

// Withdraw-specific state
const selectedOutputAsset = ref<VaultAsset | undefined>()
const isUnknownSwapToken = ref(false)

const needsSwap = computed(() => {
  if (!selectedOutputAsset.value || !form.asset.value) return false
  try {
    return getAddress(selectedOutputAsset.value.address) !== getAddress(form.asset.value.address)
  }
  catch {
    return false
  }
})

const form = useCollateralForm({
  mode: 'withdraw',
  needsSwap,
  effectiveBalance: computed(() => form.collateralAssets.value),
  effectiveAsset: computed(() => form.asset.value),

  computePriceFixed: (_pos, borrowVault, collateralVault) => {
    const collateralPrice = borrowVault && collateralVault
      ? getCollateralOraclePrice(borrowVault, collateralVault)
      : undefined
    const borrowPrice = borrowVault ? getAssetOraclePrice(borrowVault) : undefined
    return FixedPoint.fromValue(conservativePriceRatio(collateralPrice, borrowPrice), 18)
  },

  computeLiquidationPrice: (pos, borrowVault, collateralVault) => {
    const health = nanoToValue(pos.health || 0n, 18)
    if (health < 1) return undefined
    const cp = borrowVault && collateralVault ? getCollateralOraclePrice(borrowVault, collateralVault) : undefined
    const bp = borrowVault ? getAssetOraclePrice(borrowVault) : undefined
    const ratio = nanoToValue(conservativePriceRatio(cp, bp), 18)
    if (!ratio) return undefined
    return ratio / health
  },

  validateEstimate: ({ suppliedFixed, amountFixed, userLtvFixed }) => {
    if (suppliedFixed.lte(amountFixed)) {
      throw new Error('Not enough liquidity in your position')
    }
    if (!form.position.value) return
    if (userLtvFixed.gte(FixedPoint.fromValue(form.position.value.liquidationLTV, 2))) {
      throw new Error('Not enough liquidity for the vault, LTV is too large')
    }
  },

  buildDirectPlan: async ({ vaultAddress, amountNano, subAccount }) => {
    const hasBorrows = (form.position.value?.borrowed || 0n) > 0n
    return buildWithdrawPlan(
      vaultAddress,
      amountNano,
      subAccount,
      {
        includePythUpdate: hasBorrows,
        liabilityVault: form.borrowVault.value?.address,
        enabledCollaterals: form.position.value?.collaterals,
      },
    )
  },

  buildSwapPlan: async (quote: SwapApiQuote, { vaultAddress, amountNano, subAccount }) => {
    const hasBorrows = (form.position.value?.borrowed || 0n) > 0n
    return buildWithdrawAndSwapPlan({
      vaultAddress: vaultAddress as Address,
      assetsAmount: amountNano,
      quote,
      subAccount,
      options: {
        includePythUpdate: hasBorrows,
        liabilityVault: form.borrowVault.value?.address,
        enabledCollaterals: form.position.value?.collaterals,
      },
    })
  },

  requestSwapQuoteParams: ({ userAddr, subAccountAddr, amountNano, slippage, asset, vaultAddress }) => {
    if (!selectedOutputAsset.value) return null
    return {
      tokenIn: asset.address as Address,
      tokenOut: selectedOutputAsset.value.address as Address,
      accountIn: subAccountAddr,
      accountOut: zeroAddress as Address,
      amount: amountNano,
      vaultIn: vaultAddress as Address,
      receiver: userAddr,
      transferOutputToReceiver: true,
      slippage,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      targetDebt: 0n,
      currentDebt: 0n,
    }
  },

  getSwapOutputAsset: () => selectedOutputAsset.value,

  reviewLabel: 'Review Withdraw',
  reviewType: 'withdraw',
  swapReviewType: 'swap-withdraw',
  getReviewAsset: () => form.asset.value,
  getSwapToAsset: () => selectedOutputAsset.value,

  onAfterSend: () => {
    refreshAllPositions(eulerLensAddresses.value, address.value as string)
  },
})
useOperationGuard(computed(() => [form.collateralVault.value?.address, form.borrowVault.value?.address].filter(Boolean)))
const pairAssetsLabel = usePositionPairLabel(form.position)

// Withdraw-specific computeds
const withdrawWarnings = computed(() => {
  if (!form.borrowVault.value) return []
  return [
    form.hookWarning.value,
    getUtilisationWarning(form.borrowVault.value, 'borrow'),
  ]
})

const onSelectOutputAsset = (newAsset: VaultAsset, meta?: SwapTokenSelectMeta) => {
  selectedOutputAsset.value = newAsset
  isUnknownSwapToken.value = meta?.isUnknownToken ?? false
  form.amount.value = ''
  form.clearSimulationError()
  form.resetSwapQuoteState()
}

const openSwapTokenSelector = () => {
  form.openSwapTokenSelector(
    selectedOutputAsset.value?.address || form.asset.value?.address,
    onSelectOutputAsset,
  )
}

// Withdraw-specific watchers
watch(address, async () => {
  if (form.isPositionLoaded.value) {
    await form.loadSelectedCollateral()
  }
})

watch(selectedOutputAsset, () => {
  form.clearSimulationError()
  form.resetSwapQuoteState()
  if (needsSwap.value && form.amount.value) {
    form.requestSwapQuote()
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
      title="Withdraw collateral"
      description="Remove collateral from your position. Your health score will decrease."
      :loading="form.isLoading.value"
      @submit.prevent="form.submit"
    >
      <template v-if="form.collateralVault.value && form.asset.value">
        <VaultLabelsAndAssets
          :vault="form.collateralVault.value"
          :assets="[form.asset.value]"
          :assets-label="pairAssetsLabel"
          size="large"
        />

        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-if="form.position.value && form.asset.value"
              v-model="form.amount.value"
              label="Withdraw amount"
              :asset="form.asset.value"
              :vault="(form.collateralVault.value as Vault)"
              :balance="form.collateralAssets.value"
              maxable
            />

            <!-- Receive as token selector -->
            <div class="flex items-center gap-8">
              <span class="text-p3 text-content-tertiary">Receive as</span>
              <button
                type="button"
                class="flex items-center gap-6 bg-card text-p3 font-semibold px-12 h-36 rounded-[40px] whitespace-nowrap"
                @click="openSwapTokenSelector"
              >
                <AssetAvatar
                  :asset="{ address: selectedOutputAsset?.address || form.asset.value.address, symbol: selectedOutputAsset?.symbol || form.asset.value.symbol }"
                  size="20"
                />
                {{ selectedOutputAsset?.symbol || form.asset.value.symbol }}
                <SvgIcon
                  class="text-content-tertiary !w-16 !h-16"
                  name="arrow-down"
                />
              </button>
            </div>

            <!-- Swap info block -->
            <template v-if="needsSwap && selectedOutputAsset">
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
                v-if="form.swapEstimatedOutput.value"
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
              v-if="!form.isGeoBlocked.value && form.isSwapRestricted.value"
              title="Swap restricted"
              description="Swapping from this vault is not available in your region. You can withdraw the vault's underlying asset directly."
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

            <VaultWarningBanner :warnings="withdrawWarnings" />
          </div>

          <VaultFormInfoBlock
            v-if="form.position.value && form.borrowVault.value"
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
                :before="form.liquidationPrice.value != null ? formatSmartAmount(form.priceInvert.invertValue(form.liquidationPrice.value)!) : undefined"
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
                :before="formatNumber(nanoToValue(form.position.value.userLTV, 18))"
                :after="formatNumber(nanoToValue(form.estimateUserLTV.value, 18))"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="formatHealthScore(nanoToValue(form.position.value.health, 18))"
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
            >
              {{ form.submitLabel }}
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
