<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import type { SwapTokenSelectMeta } from '~/components/entities/asset/SwapTokenSelector.vue'
import { getCollateralOraclePrice, getAssetOraclePrice, conservativePriceRatio, getTokenUsdPrice } from '~/utils/sdk-prices'
import type { SwapQuote, EVault } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { nanoToValue } from '~/utils/crypto-utils'
import { useCollateralForm } from '~/composables/position/useCollateralForm'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { getAddress, type Address, zeroAddress } from 'viem'
import { isNativeCurrencyAddress, isNativeOfWrapped, resolveWrappedNativeAddress, resolveWrappedNativeAsset } from '~/utils/native-currency'
import { FixedPoint } from '~/utils/fixed-point'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isCowProviderOrQuote } from '~/entities/cowswap'

const positionIndex = usePositionIndex()
const { isConnected } = useWagmi()
const { isSpyMode } = useSpyMode()
const { getBalance } = useWallets()
const { planDeposit, planDepositWithSwap } = useEulerTx()
const { create: createIntent } = useOperationIntentFactory()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { chainId } = useEulerAddresses()
// Page uses SwapTokenSelector — opt into full wallet-token balance fetch while mounted.
useFullBalances()

// Supply-specific state
const selectedAsset = ref<VaultAsset | undefined>()
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

  buildDirectPlan: async ({ vaultAddress, assetAddress, amountNano, subAccount, account }) => {
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
      account,
    })
  },

  buildSwapPlan: async (quote: SwapQuote, { account }) => {
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
      account,
    })
  },

  createReviewIntent: (quote?: SwapQuote) => {
    const vault = form.collateralVault.value
    const asset = form.asset.value
    const receiver = form.position.value?.subAccount as Address | undefined
    if (!vault || !asset || !receiver) throw new Error('Position is not loaded')
    if (quote) {
      const selected = selectedAsset.value
      if (!selected) throw new Error('No selected asset')
      const amount = valueToNano(form.amount.value || '0', selected.decimals)
      const isNative = isNativeCurrencyAddress(selected.address)
      const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
      if (isNative && !wrappedAddress) throw new Error('Wrapped native token not found')
      return createIntent({
        kind: 'deposit',
        planner: 'deposit-with-swap',
        args: {
          swapQuote: quote,
          amount,
          tokenIn: (wrappedAddress || selected.address) as Address,
          wrappedNativeInfo: isNative && wrappedAddress
            ? { wrappedTokenAddress: wrappedAddress, nativeAmount: amount }
            : undefined,
        },
        source: 'position/supply:review',
        subAccounts: [receiver],
      })
    }
    const amount = valueToNano(form.amount.value || '0', asset.decimals)
    const wrappedAddress = isNativeWrap.value ? resolveWrappedNativeAddress(chainId.value!) : null
    return createIntent({
      kind: 'deposit',
      planner: 'deposit',
      args: {
        vaultAddress: vault.address as Address,
        assetAddress: asset.address as Address,
        amount,
        receiver,
        wrappedNativeInfo: isNativeWrap.value && wrappedAddress
          ? { wrappedTokenAddress: wrappedAddress, nativeAmount: amount }
          : undefined,
      },
      source: 'position/supply:review',
      subAccounts: [receiver],
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

// Add this collateral supply to the batch. Direct deposit or non-CoW swap
// deposit; native-wrap goes through the single-tx review path.
const isCowSwapSelected = computed(() => isCowProviderOrQuote(form.swapSelectedProvider.value, form.swapSelectedQuote.value))
const canAddToBatch = computed(() => {
  if (form.isGeoBlocked.value || form.isSwapRestricted.value || form.isInputAssetBlocked.value) return false
  if (!(+form.amount.value) || isNativeWrap.value || !form.collateralVault.value?.address || !form.position.value) return false
  if (needsSwap.value) return !!form.swapSelectedQuote.value && !isCowSwapSelected.value
  return true
})
const { guardWithPriceImpact: guardWithAddToBatchPriceImpact } = usePriceImpactGate({
  directPriceImpact: form.swapPriceImpact,
  shouldGateUnknown: computed(() =>
    needsSwap.value
    && form.swapEffectiveQuote.value !== null
    && form.swapPriceImpact.value === null,
  ),
})
const addToBatch = async () => {
  if (!canAddToBatch.value) return
  await guardWithAddToBatchPriceImpact(async () => {
    const a = form.asset.value
    const pos = form.position.value
    if (!a?.address || !pos) return
    if (needsSwap.value) {
      const quote = form.swapEffectiveQuote.value
      const sel = selectedAsset.value
      if (!quote || !sel) return
      const isNative = isNativeCurrencyAddress(sel.address)
      const inputAmount = valueToNano(form.amount.value, sel.decimals)
      const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
      if (isNative && !wrappedAddress) return
      const tokenIn = (wrappedAddress || sel.address) as Address
      const wrappedNativeInfo = isNative && wrappedAddress ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount } : undefined
      const quoteIntents = form.swapQuoteCardsSorted.value.find(card => card.quote === quote)?.intents
      await addBatchEntry({
        label: `Swap-supply ${form.amount.value} ${sel.symbol} → ${a.symbol}`,
        intent: quoteIntents?.[0] ?? createIntent({
          kind: 'deposit',
          planner: 'deposit-with-swap',
          args: { swapQuote: quote, amount: inputAmount, tokenIn, wrappedNativeInfo },
          source: 'position/supply:add-to-batch',
          subAccounts: [pos.subAccount as Address],
        }),
        subAccount: pos.subAccount as Address,
        review: { type: 'swap-supply', asset: sel, amount: form.amount.value, swapToAsset: a, quoteFetchedAt: form.swapEffectiveQuoteFetchedAt.value },
      })
    }
    else {
      const vaultAddress = form.collateralVault.value!.address as Address
      const assetAddress = a.address as Address
      const amount = valueToNano(form.amount.value, a.decimals)
      await addBatchEntry({
        label: `Supply ${form.amount.value} ${a.symbol}`,
        intent: createIntent({
          kind: 'deposit',
          planner: 'deposit',
          args: { vaultAddress, assetAddress, amount, receiver: pos.subAccount as Address },
          source: 'position/supply:add-to-batch',
          subAccounts: [pos.subAccount as Address],
        }),
        subAccount: pos.subAccount as Address,
        review: { type: 'supply', asset: a, amount: form.amount.value },
      })
    }
    form.amount.value = ''
    redirectAfterAdd('/portfolio', { subAccount: pos.subAccount })
  })
}

// Supply-specific: balance management
// Wallet balances from the central (layer-aware) wallet entity — reactive.
const balance = computed(() => {
  const addr = form.collateralVault.value?.asset.address
  return addr ? getBalance(addr as Address) : 0n
})
const selectedAssetBalance = computed(() => selectedAsset.value?.address ? getBalance(selectedAsset.value.address as Address) : 0n)

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
watch(selectedAsset, async () => {
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
      page-scroll
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

            <FormAlertStack
              :is-geo-blocked="form.isGeoBlocked.value"
              :asset-restricted="!form.isGeoBlocked.value && form.isInputAssetBlocked.value"
              asset-restricted-description="Paying with this asset is not available in your region. Pick a different token."
              :swap-restricted="!form.isGeoBlocked.value && !form.isInputAssetBlocked.value && form.isSwapRestricted.value"
              swap-restricted-description="Swapping into this vault is not available in your region. You can deposit the vault's underlying asset directly."
              :estimates-error="form.estimatesError.value"
              :simulation-error="form.simulationError.value"
            />
            <VaultWarningBanner :warnings="[form.hookWarning.value]" />
          </div>

          <PositionSummaryBlock
            :form="form"
            :visible="!!form.position.value"
            exclude-infinite-liq-price
          />

          <FormSubmitFooter
            :info-vault="form.collateralVault.value"
            :info-disabled="form.isLoading.value || form.isSubmitting.value"
            :submit-disabled="form.submitDisabled.value"
            :submit-loading="form.isSubmitting.value || form.isPreparing.value"
            :disabled-reason="disabledReasonInfo?.message"
            :disabled-reason-variant="disabledReasonInfo?.variant"
            :can-add-to-batch="canAddToBatch"
            @add-to-batch="addToBatch"
          >
            {{ form.submitLabel }}
          </FormSubmitFooter>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
