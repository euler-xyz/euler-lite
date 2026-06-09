<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import type { SwapTokenSelectMeta } from '~/components/entities/asset/SwapTokenSelector.vue'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatio } from '~/utils/sdk-prices'
import type { SwapQuote, EVault } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useCollateralForm } from '~/composables/position/useCollateralForm'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { decimalLtvToBps, getBorrowPositionEffectiveLiquidationLTV } from '~/utils/ltv'
import { getAddress, type Address, zeroAddress, maxUint256 } from 'viem'
import { FixedPoint } from '~/utils/fixed-point'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'

import { isCowProviderOrQuote } from '~/entities/cowswap'

const positionIndex = usePositionIndex()
const { address } = useWagmi()
const { planWithdraw, planWithdrawAndSwap, planRedeem } = useEulerTx()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { account: cachedAccount } = useFreshAccount()
const { refreshAllPositions } = useEulerAccount()
const { eulerLensAddresses } = useEulerAddresses()
// Page uses SwapTokenSelector — opt into full wallet-token balance fetch while mounted.
useFullBalances()

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

const cashLimitedCollateralAssets = () =>
  getCashLimitedWithdrawAmount(form.collateralAssets.value, form.collateralVault.value)

const form = useCollateralForm({
  mode: 'withdraw',
  needsSwap,
  effectiveBalance: computed(() => cashLimitedCollateralAssets()),
  effectiveAsset: computed(() => form.asset.value),

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

  validateEstimate: ({ suppliedFixed, amountFixed, userLtvFixed }) => {
    if (suppliedFixed.lte(amountFixed)) {
      throw new Error('Not enough liquidity in your position')
    }
    if (!form.position.value) return
    const effectiveLiquidationLtv = getBorrowPositionEffectiveLiquidationLTV(form.position.value)
    if (effectiveLiquidationLtv === undefined) {
      throw new Error('Liquidation LTV unavailable')
    }
    if (userLtvFixed.gte(FixedPoint.fromValue(decimalLtvToBps(effectiveLiquidationLtv), 2))) {
      throw new Error('Not enough liquidity for the vault, LTV is too large')
    }
    if (cashLimitedCollateralAssets() < amountFixed.value) {
      throw new Error('Not enough liquidity in vault')
    }
  },

  buildDirectPlan: async ({ vaultAddress, amountNano, subAccount, account }) => {
    const owner = (subAccount ?? address.value) as Address
    // Withdrawing the entire collateral balance: redeem ALL shares (maxUint256)
    // instead of a fixed asset amount. A fixed `withdraw(assets)` leaves dust
    // behind (share-price rounding + interest accrued since the snapshot).
    if (isFullCollateralWithdraw(amountNano)) {
      return planRedeem({
        vaultAddress: vaultAddress as Address,
        shares: maxUint256,
        owner,
        account: account ?? cachedAccount.value,
      })
    }
    return planWithdraw({
      vaultAddress: vaultAddress as Address,
      assets: amountNano,
      owner,
      // Skip planner's freshPlanContext fetch; reuse the race-replace snapshot.
      account: account ?? cachedAccount.value,
    })
  },

  buildSwapPlan: async (quote: SwapQuote, { vaultAddress, amountNano, subAccount, account }) => {
    const owner = (subAccount ?? address.value) as Address
    return planWithdrawAndSwap({
      swapQuote: quote,
      vaultAddress: vaultAddress as Address,
      assets: amountNano,
      owner,
      account: account ?? cachedAccount.value,
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
  usePreparedPipeline: true,
})
useOperationGuard(computed(() => [form.collateralVault.value?.address, form.borrowVault.value?.address].filter(Boolean)))
const withdrawableCollateralAssets = computed(() => cashLimitedCollateralAssets())

// True when the requested amount covers the entire collateral balance. The Max
// button fills the exact full-precision balance, so this is an exact match when
// the position isn't cash-limited. A full withdraw must redeem ALL shares
// (maxUint256) rather than a fixed asset amount — otherwise share-price rounding
// and interest accrued since the snapshot leave dust behind.
const isFullCollateralWithdraw = (assetsNano: bigint) => {
  const full = form.collateralAssets.value
  return full > 0n && assetsNano >= full
}

// Add this collateral withdrawal to the batch — direct or non-CoW swap-out.
const isCowSwapSelected = computed(() => isCowProviderOrQuote(form.swapSelectedProvider.value, form.swapSelectedQuote.value))
const canAddToBatch = computed(() => {
  if (!(+form.amount.value) || !form.collateralVault.value?.address || !form.position.value) return false
  if (needsSwap.value) return !!form.swapSelectedQuote.value && !isCowSwapSelected.value
  return true
})
const addToBatch = () => {
  if (!canAddToBatch.value) return
  const v = form.collateralVault.value
  const a = form.asset.value
  const pos = form.position.value
  if (!v?.address || !a?.address || !pos) return
  const vaultAddress = v.address as Address
  const assets = valueToNano(form.amount.value, a.decimals)
  const owner = (pos.subAccount ?? address.value) as Address
  if (needsSwap.value) {
    const quote = form.swapEffectiveQuote.value
    if (!quote) return
    addBatchEntry({
      label: `Withdraw-swap ${form.amount.value} ${a.symbol} → ${selectedOutputAsset.value?.symbol ?? ''}`,
      buildPlan: account => planWithdrawAndSwap({ swapQuote: quote, vaultAddress, assets, owner, account }),
      subAccount: pos.subAccount as Address,
      review: { type: 'swap-withdraw', asset: a, amount: form.amount.value, swapToAsset: selectedOutputAsset.value },
    })
  }
  else if (isFullCollateralWithdraw(assets)) {
    addBatchEntry({
      label: `Withdraw ${form.amount.value} ${a.symbol}`,
      buildPlan: account => planRedeem({ vaultAddress, shares: maxUint256, owner, account }),
      subAccount: pos.subAccount as Address,
      review: { type: 'withdraw', asset: a, amount: form.amount.value },
    })
  }
  else {
    addBatchEntry({
      label: `Withdraw ${form.amount.value} ${a.symbol}`,
      buildPlan: account => planWithdraw({ vaultAddress, assets, owner, account }),
      subAccount: pos.subAccount as Address,
      review: { type: 'withdraw', asset: a, amount: form.amount.value },
    })
  }
  form.amount.value = ''
  redirectAfterAdd('/portfolio')
}

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (form.isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (form.isOutputAssetBlocked.value || form.isOutputAssetRestricted.value) return { message: 'Receiving this asset is not available in your region', variant: 'warning' }
  if (form.isSwapRestricted.value) return { message: 'Swapping from this vault is not available in your region', variant: 'warning' }
  if (form.estimatesError.value) return { message: form.estimatesError.value, variant: 'error' }
  if (form.simulationError.value) return { message: form.simulationError.value, variant: 'error' }
  if (needsSwap.value && form.isSwapQuoteLoading.value && +form.amount.value > 0) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (needsSwap.value && !form.swapSelectedQuote.value && +form.amount.value > 0) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})
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
              :vault="(form.collateralVault.value as EVault)"
              :balance="withdrawableCollateralAssets"
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

              <UiAlert
                v-if="form.swapQuoteError.value"
                title="Swap quote"
                variant="warning"
                :description="form.swapQuoteError.value"
                size="compact"
              />
            </template>

            <UiAlert
              v-if="isUnknownSwapToken && needsSwap"
              title="Unknown token"
              description="This token is not on any recognized token list. It could be fraudulent or malicious. Verify the contract address before proceeding."
              variant="warning"
              size="compact"
            />

            <UiAlert
              v-if="form.isGeoBlocked.value"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-if="!form.isGeoBlocked.value && (form.isOutputAssetBlocked.value || form.isOutputAssetRestricted.value)"
              title="Asset restricted"
              description="Receiving this asset is not available in your region. Pick a different token."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-if="!form.isGeoBlocked.value && !form.isOutputAssetBlocked.value && !form.isOutputAssetRestricted.value && form.isSwapRestricted.value"
              title="Swap restricted"
              description="Swapping from this vault is not available in your region. You can withdraw the vault's underlying asset directly."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-show="form.estimatesError.value"
              title="Error"
              variant="error"
              :description="form.estimatesError.value"
              size="compact"
            />
            <UiAlert
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
                :before="formatNumber(ltvToPercent(nanoToValue(form.position.value.userLTV ?? form.position.value.currentLTV ?? 0n, 18)))"
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
              :can-add-to-batch="canAddToBatch"
              @add-to-batch="addToBatch"
            >
              {{ form.submitLabel }}
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
