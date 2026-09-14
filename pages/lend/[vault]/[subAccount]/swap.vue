<script setup lang="ts">
import type { SecuritizeCollateralVault, EVault, SwapQuote, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getSubAccountAddress, isEVault, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { isSecuritizeVault } from '~/utils/vault/categories'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { formatSmartAmount } from '~/utils/string-utils'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import type { SwapQuotePlanContext } from '~/composables/useSwapQuotesParallel'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { getAddress, type Address, zeroAddress, isAddress } from 'viem'
import { COWSWAP_BATCH_UNSUPPORTED_REASON, isCowProviderOrQuote } from '~/entities/cowswap'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'
import { getProjectedRatesBatch } from '~/utils/vault/apy'
import { nanoToValue } from '~/utils/crypto-utils'
import { createRaceGuard } from '~/utils/race-guard'
import {
  getProjectedYieldState,
  mergeProjectedRewardCampaigns,
  type ProjectedYieldDetails,
} from '~/utils/projected-yield'
import { buildLendSwapProjectionPlan, resolveLendSwapProjectedRates } from '~/utils/lend-swap-apy'
import { getLayeredVault } from '~/composables/useLayeredVaults'

const route = useRoute()
const { getVault, getSecuritizeVault } = useVaults()
const { effectiveAddress } = useEffectiveAddress()
const { depositPositions } = useEulerAccount()
const { planCollateralChange } = useEulerTx()
const { create: createIntent } = useOperationIntentFactory()
const { account: planAccount } = usePlanAccount()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const {
  version: rewardsVersion,
  getSupplyRewardApy,
  getSupplyRewardCampaigns,
} = useRewardsApy()

const subAccountIndex = Number(route.params.subAccount)
const subAccount = computed(() => {
  const addr = effectiveAddress.value
  if (!addr || isNaN(subAccountIndex)) return undefined
  return getSubAccountAddress(getAddress(addr), subAccountIndex)
})

// ── Vaults ───────────────────────────────────────────────────────────────
const fromVault: Ref<EVault | SecuritizeCollateralVault | undefined> = ref()
const toVault: Ref<EVault | undefined> = ref()
const projectionFromVault = computed(() => {
  const fallback = fromVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})
const projectionToVault = computed(() => {
  const fallback = toVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})
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
  projectionFromVault.value,
))

// ── Supply APY ───────────────────────────────────────────────────────────
const fromSupplyApy = computed(() => {
  const vault = projectionFromVault.value
  if (!vault) return null
  const base = getVaultSupplyApy(vault)
  return withVaultIntrinsicApy(base, vault, enableIntrinsicApy.value) + getSupplyRewardApy(vault.address)
})
const toSupplyApy = computed(() => {
  const vault = projectionToVault.value
  if (!vault) return null
  const base = getVaultSupplyApy(vault)
  return withVaultIntrinsicApy(base, vault, enableIntrinsicApy.value) + getSupplyRewardApy(vault.address)
})
const projectedFromSupplyApy = ref<number | null>(null)
const projectedToSupplyApy = ref<number | null>(null)
const fromProjectedYieldDetails = ref<ProjectedYieldDetails | null>(null)
const toProjectedYieldDetails = ref<ProjectedYieldDetails | null>(null)
const isYieldEstimateLoading = ref(false)

const buildProjectedSupplyDetails = (vault: EVault, projectedRaw: number): ProjectedYieldDetails | null => {
  const currentRaw = getVaultSupplyApy(vault)
  const currentWithIntrinsic = withVaultIntrinsicApy(currentRaw, vault, enableIntrinsicApy.value)
  const projectedWithIntrinsic = withVaultIntrinsicApy(projectedRaw, vault, enableIntrinsicApy.value)
  const rewardApy = getSupplyRewardApy(vault.address)
  const before = getProjectedYieldState('supply-apy', {
    supplyUsd: 1,
    baseSupplyApy: currentRaw,
    intrinsicSupplyApy: currentWithIntrinsic - currentRaw,
    supplyRewardApy: rewardApy,
    borrowUsd: 0,
    baseBorrowApy: 0,
  })
  const after = getProjectedYieldState('supply-apy', {
    supplyUsd: 1,
    baseSupplyApy: projectedRaw,
    intrinsicSupplyApy: projectedWithIntrinsic - projectedRaw,
    supplyRewardApy: rewardApy,
    borrowUsd: 0,
    baseBorrowApy: 0,
  })
  if (!after) return null
  const campaigns = getSupplyRewardCampaigns(vault.address)
    .map(campaign => ({ campaign, vaultAddress: vault.address }))
  return {
    metric: 'supply-apy',
    before,
    after,
    rateLines: [{
      id: `supply:${vault.address.toLowerCase()}`,
      label: 'Lending APY',
      symbol: vault.asset.symbol,
      vaultAddress: vault.address,
      before: currentRaw,
      after: projectedRaw,
    }],
    rewards: mergeProjectedRewardCampaigns(campaigns, campaigns),
  }
}

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

  createReviewIntent(quote?: SwapQuote) {
    const from = fromVault.value
    const to = toVault.value
    const positionAccount = subAccount.value ?? effectiveAddress.value
    if (!from || !to || !positionAccount) throw new Error('Position is not loaded')
    const amount = valueToNano(fromAmount.value, from.asset.decimals)
    const isMax = assetsBalance.value > 0n && amount >= assetsBalance.value
    if (quote) {
      return createIntent({
        kind: 'collateral',
        planner: 'swap-collateral',
        args: { swapQuote: quote, swapperMode: SwapperMode.EXACT_IN },
        source: 'lend/swap:review',
        subAccounts: [positionAccount as Address],
      })
    }
    return createIntent({
      kind: 'refinance',
      planner: 'migrate-same-asset-collateral',
      args: {
        fromVault: from.address as Address,
        toVault: to.address as Address,
        amount,
        positionAccount: positionAccount as Address,
        toAsset: to.asset.address as Address,
        isMax,
        maxShares: isMax ? savingPosition.value?.shares : undefined,
      },
      source: 'lend/swap:review',
      subAccounts: [positionAccount as Address],
    })
  },

  getBalanceError: (amountNano) => {
    if (assetsBalance.value < amountNano) return 'Not enough balance'
    if (balance.value < amountNano) return 'Not enough liquidity in vault'
    return null
  },
  getGeoBlockedAddresses: () => [fromVault.value?.address, toVault.value?.address].filter((address): address is Address => Boolean(address)),
})

const {
  isLoading, isSubmitting, isPreparing, fromAmount, toAmount, slippage,
  isSameAsset, sameVaultError, errorText,
  isGeoBlocked, reviewSwapDisabled, reviewSwapLabel, simulationError,
  isQuoteLoading, quoteError, quotesStatusLabel, selectedProvider, selectedQuote,
  quoteCardsSorted, effectiveQuoteFetchedAt,
  fromProduct, toProduct, currentPrice, swapSummary, priceImpact, routedVia,
  swapRouteItems, swapRouteEmptyMessage,
  selectProvider, onFromInput, onToVaultChange, onRefreshQuotes, submit, openSlippageSettings,
} = swap

const yieldEstimateGuard = createRaceGuard()
const updateYieldEstimates = useDebounceFn(async (gen: number) => {
  if (yieldEstimateGuard.isStale(gen)) return
  const source = projectionFromVault.value
  const target = projectionToVault.value
  const sourceAmount = fromAmount.value
  const sameAsset = isSameAsset.value
  const quote = selectedQuote.value
  projectedFromSupplyApy.value = null
  projectedToSupplyApy.value = null
  fromProjectedYieldDetails.value = null
  toProjectedYieldDetails.value = null
  if (!source || !target || !(+sourceAmount > 0)) {
    isYieldEstimateLoading.value = false
    return
  }
  if (normalizeAddress(source.address) === normalizeAddress(target.address) || (!sameAsset && !quote)) {
    isYieldEstimateLoading.value = false
    return
  }

  try {
    const sourceAmountNano = valueToNano(sourceAmount, source.asset.decimals)
    const targetAmountNano = sameAsset
      ? sourceAmountNano
      : BigInt(quote?.amountOut || 0)
    if (targetAmountNano <= 0n) {
      isYieldEstimateLoading.value = false
      return
    }

    const plan = buildLendSwapProjectionPlan(
      isEVault(source) ? source : null,
      target,
      sourceAmountNano,
      targetAmountNano,
    )
    const projectedRates = await getProjectedRatesBatch(plan.requests)
    if (yieldEstimateGuard.isStale(gen)) return
    const resolvedRates = resolveLendSwapProjectedRates(plan, projectedRates)
    if (!resolvedRates) return

    if (resolvedRates.source && isEVault(source)) {
      const sourceRaw = nanoToValue(resolvedRates.source.supplyAPY, 25)
      const details = buildProjectedSupplyDetails(source, sourceRaw)
      projectedFromSupplyApy.value = details?.after.total ?? null
      fromProjectedYieldDetails.value = details
    }
    const targetRaw = nanoToValue(resolvedRates.target.supplyAPY, 25)
    const targetDetails = buildProjectedSupplyDetails(target, targetRaw)
    projectedToSupplyApy.value = targetDetails?.after.total ?? null
    toProjectedYieldDetails.value = targetDetails
  }
  catch (error) {
    if (yieldEstimateGuard.isStale(gen)) return
    console.warn('[lend swap] failed to project supply APYs', error)
  }
  finally {
    if (!yieldEstimateGuard.isStale(gen)) isYieldEstimateLoading.value = false
  }
}, 500)

const queueYieldEstimates = () => {
  const gen = yieldEstimateGuard.next()
  projectedFromSupplyApy.value = null
  projectedToSupplyApy.value = null
  fromProjectedYieldDetails.value = null
  toProjectedYieldDetails.value = null
  const canProject = !!fromVault.value
    && !!toVault.value
    && +fromAmount.value > 0
    && normalizeAddress(fromVault.value.address) !== normalizeAddress(toVault.value.address)
    && (isSameAsset.value || !!selectedQuote.value)
  if (!canProject) {
    isYieldEstimateLoading.value = false
    return
  }
  isYieldEstimateLoading.value = true
  updateYieldEstimates(gen)
}

const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()

// Add this earn-position swap (or same-asset migration) to the batch. CoW
// orders can't be merged into an EVC batch, so they're excluded.
const isCowSwapSelected = computed(() =>
  !isSameAsset.value && isCowProviderOrQuote(selectedProvider.value, selectedQuote.value),
)
const canAddToBatch = computed(() => {
  if (isGeoBlocked.value) return false
  if (!fromVault.value || !toVault.value || !(+fromAmount.value)) return false
  if (isSameAsset.value) return true
  return !!selectedQuote.value && !isCowSwapSelected.value
})
const { guardWithPriceImpact: guardWithAddToBatchPriceImpact } = usePriceImpactGate({
  directPriceImpact: priceImpact,
  shouldGateUnknown: computed(() =>
    !isSameAsset.value
    && selectedQuote.value !== null
    && priceImpact.value === null,
  ),
})
const addToBatch = async () => {
  if (!canAddToBatch.value) return
  await guardWithAddToBatchPriceImpact(async () => {
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
    const quoteIntents = swapQuote
      ? quoteCardsSorted.value.find(card => card.quote === swapQuote)?.intents
      : undefined
    const label = sameAsset
      ? `Migrate ${fromAmount.value} ${from.asset.symbol} → ${to.asset.symbol}`
      : `Swap ${fromAmount.value} ${from.asset.symbol} → ${to.asset.symbol}`
    const intent = createIntent({
      kind: sameAsset ? 'refinance' : 'collateral',
      planner: sameAsset ? 'migrate-same-asset-collateral' : 'swap-collateral',
      args: sameAsset
        ? { fromVault: fromAddr, toVault: toAddr, amount, positionAccount, toAsset: toAssetAddr, isMax, maxShares }
        : { swapQuote, swapperMode: SwapperMode.EXACT_IN },
      source: 'lend/swap:add-to-batch',
      subAccounts: [positionAccount],
    })
    await addBatchEntry({
      label,
      intent,
      preparedIntent: quoteIntents?.[0],
      subAccount: positionAccount,
      review: { type: 'swap', asset: from.asset, amount: fromAmount.value, swapToAsset: to.asset, swapMode: SwapperMode.EXACT_IN, quoteFetchedAt: sameAsset ? null : effectiveQuoteFetchedAt.value },
    })
    fromAmount.value = ''
    redirectAfterAdd('/portfolio/saving', { subAccount: positionAccount, vault: toAddr })
  })
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

watch(
  [
    fromAmount,
    fromVault,
    toVault,
    isSameAsset,
    selectedQuote,
    rewardsVersion,
    enableIntrinsicApy,
    () => isEVault(projectionFromVault.value) ? projectionFromVault.value.totalCash : undefined,
    () => isEVault(projectionFromVault.value) ? projectionFromVault.value.totalBorrowed : undefined,
    () => projectionToVault.value?.totalCash,
    () => projectionToVault.value?.totalBorrowed,
  ],
  queueYieldEstimates,
)
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
            :loading="(!isSameAsset && isQuoteLoading) || isYieldEstimateLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <ProjectedYieldSummaryRow
              :label="`${fromVault.asset.symbol || 'Token1'} supply APY`"
              :before="fromSupplyApy"
              :after="projectedFromSupplyApy"
              :details="fromProjectedYieldDetails"
            />
            <ProjectedYieldSummaryRow
              :label="`${toVault?.asset?.symbol || 'Token2'} supply APY`"
              :before="toSupplyApy"
              :after="projectedToSupplyApy"
              :details="toProjectedYieldDetails"
            />
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
              :add-to-batch-disabled-reason="isCowSwapSelected ? COWSWAP_BATCH_UNSUPPORTED_REASON : undefined"
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
