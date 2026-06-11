<script setup lang="ts">
import type { SecuritizeCollateralVault, EVault, SwapQuote, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getSubAccountAddress, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { isSecuritizeVault } from '~/utils/vault/categories'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { formatNumber, formatSmartAmount } from '~/utils/string-utils'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'
import type { SwapQuotePlanContext } from '~/composables/useSwapQuotesParallel'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { getAddress, type Address, zeroAddress, isAddress } from 'viem'
import { isCowProvider } from '~/entities/cowswap'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'

const route = useRoute()
const { getVault, getSecuritizeVault } = useVaults()
const { address } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const effectiveAddress = computed(() => isSpyMode.value ? spyAddress.value : address.value)
const { depositPositions } = useEulerAccount()
const { planCollateralChange } = useEulerTx()
const { account: planAccount } = usePlanAccount()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy } = useRewardsApy()

const subAccountIndex = Number(route.params.subAccount)
const subAccount = computed(() => {
  const addr = effectiveAddress.value
  if (!addr || isNaN(subAccountIndex)) return undefined
  return getSubAccountAddress(getAddress(addr), subAccountIndex)
})

// ── Vaults ───────────────────────────────────────────────────────────────
const fromVault: Ref<EVault | SecuritizeCollateralVault | undefined> = ref()
const toVault: Ref<EVault | undefined> = ref()
useOperationGuard(computed(() => [fromVault.value?.address, toVault.value?.address].filter(Boolean)))

const fromVaultAsRegular = computed(() => fromVault.value as EVault | undefined)
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
    normalizeAddress(position.vault?.address || '') === currentAddress
    && (!subAccount.value || normalizeAddress(position.subAccount) === normalizeAddress(subAccount.value)),
  ) || null
})

const assetsBalance = computed(() => savingPosition.value?.assets || 0n)
const balance = computed(() => getCashLimitedWithdrawAmount(
  assetsBalance.value,
  fromVault.value,
))

// ── Supply APY ───────────────────────────────────────────────────────────
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
  swapperMode: SwapperMode.EXACT_IN,
  getPlanAccount: () => planAccount.value,

  buildQuoteRequest(amount) {
    if (!fromVault.value || !toVault.value) return null
    const account = (subAccount.value ?? effectiveAddress.value ?? zeroAddress) as Address
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

  async buildPlan(quote?: SwapQuote, context?: SwapQuotePlanContext): Promise<TransactionPlan> {
    if (!fromVault.value || !toVault.value) throw new Error('Vaults not loaded')
    const amount = valueToNano(fromAmount.value, fromVault.value.asset.decimals)
    const isMax = assetsBalance.value > 0n && amount >= assetsBalance.value
    const swapQuote = quote ?? selectedQuote.value
    if (!isSameAsset.value && !swapQuote) throw new Error('No quote selected')
    const positionAccount = subAccount.value ?? effectiveAddress.value
    if (!positionAccount) throw new Error('Account not loaded')
    return planCollateralChange({
      fromVault: fromVault.value.address as Address,
      toVault: toVault.value.address as Address,
      amount,
      positionAccount: positionAccount as Address,
      toAsset: toVault.value.asset.address as Address,
      isMax,
      maxShares: isMax ? savingPosition.value?.shares : undefined,
      swapQuote: isSameAsset.value ? undefined : swapQuote!,
      swapperMode: SwapperMode.EXACT_IN,
      account: context?.account ?? planAccount.value,
    })
  },

  getBalanceError: (amountNano) => {
    if (assetsBalance.value < amountNano) return 'Not enough balance'
    if (balance.value < amountNano) return 'Not enough liquidity in vault'
    return null
  },
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

const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()

// Add this earn-position swap (or same-asset migration) to the batch. CoW
// orders can't be merged into an EVC batch, so they're excluded.
const isCowSwapSelected = computed(() => isCowProvider(selectedProvider.value))
const canAddToBatch = computed(() => {
  if (!fromVault.value || !toVault.value || !(+fromAmount.value)) return false
  if (isSameAsset.value) return true
  return !!selectedQuote.value && !isCowSwapSelected.value
})
const addToBatch = async () => {
  if (!canAddToBatch.value) return
  const from = fromVault.value
  const to = toVault.value
  if (!from || !to) return
  const positionAccount = (subAccount.value ?? effectiveAddress.value) as Address | undefined
  if (!positionAccount) return
  const fromAddr = from.address as Address
  const toAddr = to.address as Address
  const toAssetAddr = to.asset.address as Address
  const amount = valueToNano(fromAmount.value, from.asset.decimals)
  const isMax = assetsBalance.value > 0n && amount >= assetsBalance.value
  const maxShares = isMax ? savingPosition.value?.shares : undefined
  const sameAsset = isSameAsset.value
  const swapQuote = sameAsset ? undefined : selectedQuote.value ?? undefined
  const label = sameAsset
    ? `Migrate ${fromAmount.value} ${from.asset.symbol} → ${to.asset.symbol}`
    : `Swap ${fromAmount.value} ${from.asset.symbol} → ${to.asset.symbol}`
  await addBatchEntry({
    label,
    buildPlan: account => planCollateralChange({
      fromVault: fromAddr,
      toVault: toAddr,
      amount,
      positionAccount,
      toAsset: toAssetAddr,
      isMax,
      maxShares,
      swapQuote,
      swapperMode: SwapperMode.EXACT_IN,
      account,
    }),
    subAccount: positionAccount,
    review: { type: 'swap', asset: from.asset, amount: fromAmount.value, swapToAsset: to.asset, swapMode: SwapperMode.EXACT_IN },
  })
  fromAmount.value = ''
  redirectAfterAdd('/portfolio/saving', { subAccount: positionAccount, vault: toAddr })
}

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (sameVaultError.value) return { message: sameVaultError.value, variant: 'error' }
  if (errorText.value) return { message: errorText.value, variant: 'error' }
  if (quoteError.value) return { message: quoteError.value, variant: 'warning' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  if (!isSameAsset.value && isQuoteLoading.value && +fromAmount.value > 0) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (!isSameAsset.value && !selectedQuote.value && +fromAmount.value > 0) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})

// ── Vault loading ────────────────────────────────────────────────────────
const loadVaults = async () => {
  isLoading.value = true
  try {
    const baseAddress = getVaultAddress()
    const targetAddress = typeof route.query.to === 'string' ? route.query.to : ''

    const isFromSecuritize = await isSecuritizeVault(baseAddress)
    if (isFromSecuritize) {
      fromVault.value = await getSecuritizeVault(baseAddress)
    }
    else {
      fromVault.value = await getVault(baseAddress)
    }

    if (targetAddress && isAddress(targetAddress) && getAddress(targetAddress) !== getAddress(baseAddress)) {
      toVault.value = await getVault(targetAddress)
    }
    else if (!isFromSecuritize) {
      toVault.value = fromVault.value as EVault
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
  <div class="relative flex gap-32">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="`/lend/${vaultAddress}`"
    />
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

            <UiAlert
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still withdraw existing deposits."
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
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <UiAlert
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
                :input-exact-display="swapSummary?.fromExact ?? null"
                :output-display="swapSummary?.to ?? null"
                :output-exact-display="swapSummary?.toExact ?? null"
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
              :disabled-reason="disabledReasonInfo?.message"
              :disabled-reason-variant="disabledReasonInfo?.variant"
              :loading="isSubmitting || isPreparing"
              :can-add-to-batch="canAddToBatch"
              @add-to-batch="addToBatch"
            >
              {{ reviewSwapLabel }}
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
