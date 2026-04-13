<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { isAddress, getAddress, zeroAddress, type Address } from 'viem'
import { type Vault, type SecuritizeVault, fetchSecuritizeVault } from '~/entities/vault'
import { isSecuritizeVault } from '~/entities/vault/factory'
import { getSubAccountAddress } from '~/entities/account'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { SwapperMode } from '~/entities/swap'
import type { TxPlan } from '~/entities/txPlan'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { formatNumber, formatSmartAmount } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'

const route = useRoute()
const { getVault } = useVaults()
const { address } = useAccount()
const { depositPositions } = useEulerAccount()
const { buildSwapPlan, buildSameAssetSwapPlan } = useEulerOperations()
const { withIntrinsicSupplyApy } = useIntrinsicApy()
const { getSupplyRewardApy } = useRewardsApy()

const subAccountIndex = Number(route.params.subAccount)
const subAccount = computed(() => {
  if (!address.value || isNaN(subAccountIndex)) return undefined
  return getSubAccountAddress(address.value, subAccountIndex)
})

// ── Vaults ───────────────────────────────────────────────────────────────
const fromVault: Ref<Vault | SecuritizeVault | undefined> = ref()
const toVault: Ref<Vault | undefined> = ref()
useOperationGuard(computed(() => [fromVault.value?.address, toVault.value?.address].filter(Boolean)))

const fromVaultAsRegular = computed(() => fromVault.value as Vault | undefined)
const { collateralOptions, collateralVaults } = useSwapCollateralOptions({ currentVault: fromVaultAsRegular })
const toVaultOptions = computed(() => collateralVaults.value.filter(vault => !isVaultDeprecated(vault.address)))
const toVaultOptionAddresses = computed(() => new Set(toVaultOptions.value.map(vault => normalizeAddress(vault.address))))
const toCollateralOptions = computed(() => {
  return collateralOptions.value.filter((option) => {
    if (!option.vaultAddress) return false
    return toVaultOptionAddresses.value.has(normalizeAddress(option.vaultAddress))
  })
})

const getVaultAddress = () => route.params.vault as string
const vaultAddress = computed(() => route.params.vault as string)

// ── Position ─────────────────────────────────────────────────────────────
const savingPosition = computed(() => {
  if (!fromVault.value) return null
  const currentAddress = normalizeAddress(fromVault.value.address)
  if (!currentAddress) return null
  return depositPositions.value.find(position =>
    normalizeAddress(position.vault.address) === currentAddress
    && (!subAccount.value || normalizeAddress(position.subAccount) === normalizeAddress(subAccount.value)),
  ) || null
})

const balance = computed(() => savingPosition.value?.assets || 0n)

// ── Supply APY ───────────────────────────────────────────────────────────
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

// ── Shared swap logic ────────────────────────────────────────────────────
const swap = useSwapPageLogic({
  amountField: 'amountOut',
  compare: 'max',
  fromVault,
  toVault,
  balance,
  vaultOptions: toVaultOptions,
  displayAmountField: 'amountOut',
  quoteDiffPrefix: '-',
  redirectPath: '/portfolio/saving',

  buildQuoteRequest(amount) {
    if (!fromVault.value || !toVault.value) return null
    return {
      params: {
        tokenIn: fromVault.value.asset.address as Address,
        tokenOut: toVault.value.asset.address as Address,
        accountIn: (address.value || zeroAddress) as Address,
        accountOut: (address.value || zeroAddress) as Address,
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
    if (isSameAsset.value) {
      if (!fromVault.value || !toVault.value) throw new Error('Vaults not loaded')
      const amount = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
      const isMax = balance.value > 0n && amount >= balance.value
      return buildSameAssetSwapPlan({
        fromVaultAddress: fromVault.value.address,
        toVaultAddress: toVault.value.address,
        amount,
        isMax,
        maxShares: isMax ? savingPosition.value?.shares : undefined,
      })
    }
    if (!selectedQuote.value) throw new Error('No quote selected')
    return buildSwapPlan({
      quote: selectedQuote.value,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      targetDebt: 0n,
      currentDebt: 0n,
    })
  },

  getBalanceError: amountNano => balance.value < amountNano ? 'Not enough balance' : null,
  getGeoBlockedAddresses: () => [getVaultAddress()],
})

const {
  isLoading, isSubmitting, isPreparing, fromAmount, toAmount, slippage,
  isSameAsset, sameVaultError, errorText,
  isGeoBlocked, reviewSwapDisabled, reviewSwapLabel, simulationError,
  isQuoteLoading, quoteError, quotesStatusLabel, selectedProvider, selectedQuote,
  fromProduct, toProduct, currentPrice, swapSummary, priceImpact, routedVia,
  swapRouteItems, swapRouteEmptyMessage,
  selectProvider, onFromInput, onToVaultChange, onRefreshQuotes, submit, openSlippageSettings,
} = swap

// ── Vault loading ────────────────────────────────────────────────────────
const loadVaults = async () => {
  isLoading.value = true
  try {
    const baseAddress = getVaultAddress()
    const targetAddress = typeof route.query.to === 'string' ? route.query.to : ''

    const isFromSecuritize = await isSecuritizeVault(baseAddress)
    if (isFromSecuritize) {
      fromVault.value = await fetchSecuritizeVault(baseAddress)
    }
    else {
      fromVault.value = await getVault(baseAddress)
    }

    if (targetAddress && isAddress(targetAddress) && getAddress(targetAddress) !== getAddress(baseAddress)) {
      toVault.value = await getVault(targetAddress)
    }
    else if (!isFromSecuritize) {
      toVault.value = fromVault.value as Vault
    }
  }
  catch (e) {
    console.warn('[lend swap] failed to load vaults', e)
  }
  finally {
    isLoading.value = false
  }
}

// Non-blocking to avoid Suspense + pageTransition crash on direct navigation
loadVaults()

watch([() => route.params.vault, () => route.query.to], () => {
  loadVaults()
})
</script>

<template>
  <div class="flex gap-32">
    <VaultForm
      back
      :back-fallback="`/lend/${vaultAddress}`"
      title="Rebalance savings"
      description="Move your supplied assets from one vault to another."
      class="flex flex-col gap-16 w-full"
      :loading="isLoading"
      @submit.prevent="submit"
    >
      <template v-if="fromVault">
        <VaultLabelsAndAssets
          :vault="fromVault"
          :assets="[fromVault.asset]"
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
              v-if="!isSameAsset"
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
              :collateral-options="toCollateralOptions"
              collateral-modal-title="Select vault"
              :readonly="true"
              @change-collateral="onToVaultChange"
            />
            <div
              v-else
              class="bg-card rounded-16 p-16 text-content-primary"
            >
              No asset swap options available
            </div>

            <UiToast
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still withdraw existing deposits."
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
              v-if="sameVaultError"
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
              v-if="quoteError"
              title="Swap quote"
              variant="warning"
              :description="quoteError"
              size="compact"
            />
          </div>

          <VaultFormInfoBlock
            :loading="!isSameAsset && isQuoteLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow :label="`${fromVault.asset.symbol || 'Token1'} supply APY`">
              <p class="text-p2">
                {{ fromSupplyApy !== null ? `${formatNumber(fromSupplyApy)}%` : '-' }}
              </p>
            </SummaryRow>
            <SummaryRow :label="`${toVault?.asset?.symbol || 'Token2'} supply APY`">
              <p class="text-p2">
                {{ toSupplyApy !== null ? `${formatNumber(toSupplyApy)}%` : '-' }}
              </p>
            </SummaryRow>
            <template v-if="!isSameAsset">
              <SummaryRow
                label="Swap price"
                align-top
              >
                <p class="text-p2 text-right">
                  {{ currentPrice ? `${formatSmartAmount(currentPrice.value)} ${currentPrice.symbol}` : '-' }}
                </p>
              </SummaryRow>
              <SwapDetailsSummary
                :input-display="swapSummary?.from ?? null"
                :output-display="swapSummary?.to ?? null"
                :price-impact="priceImpact"
                :slippage="slippage"
                :routed-via="routedVia"
                @open-slippage-settings="openSlippageSettings"
              />
            </template>
            <SummaryRow
              v-else
              label="Transfer"
            >
              <p class="text-p2">
                1:1 (same asset, no slippage)
              </p>
            </SummaryRow>
          </VaultFormInfoBlock>

          <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
            <VaultFormSubmit
              :disabled="reviewSwapDisabled"
              :loading="isSubmitting || isPreparing"
            >
              {{ reviewSwapLabel }}
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
