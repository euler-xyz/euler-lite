<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { type Vault, type VaultAsset, getNetAPY } from '~/entities/vault'
import { getAssetUsdValueOrZero, getCollateralOraclePrice, getAssetOraclePrice, conservativePriceRatioNumber } from '~/services/pricing/priceProvider'
import { type AccountBorrowPosition, isPositionEligibleForLiquidation } from '~/entities/account'
import type { TxPlan } from '~/entities/txPlan'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { useModal } from '~/components/ui/composables/useModal'
import { SlippageSettingsModal, SwapTokenSelector } from '#components'
import { nanoToValue } from '~/utils/crypto-utils'
import { createRaceGuard } from '~/utils/race-guard'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { useWalletRepay } from '~/composables/repay/useWalletRepay'
import { useWalletSwapRepay } from '~/composables/repay/useWalletSwapRepay'
import { useCollateralSwapRepay } from '~/composables/repay/useCollateralSwapRepay'
import { useSavingsRepay } from '~/composables/repay/useSavingsRepay'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'

const _route = useRoute()
const _router = useRouter()
const modal = useModal()
const { isConnected, address } = useAccount()
const { isSpyMode } = useSpyMode()
const positionIndex = usePositionIndex()
const { isPositionsLoading, isPositionsLoaded, isDepositsLoaded, refreshAllPositions: _refreshAllPositions, getPositionBySubAccountIndex } = useEulerAccount()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
const { eulerLensAddresses: _eulerLensAddresses } = useEulerAddresses()
const { fetchSingleBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTxPlanSimulation()
const { slippage } = useSlippage()
// --- Shared state ---
const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const formTab = ref<'wallet' | 'collateral' | 'savings'>('wallet')
const plan = ref<TxPlan | null>(null)
const position: Ref<AccountBorrowPosition | undefined> = ref()
const walletBalance = ref(0n)

// --- Shared computeds ---
const borrowVault = computed(() => position.value?.borrow)
const collateralVault = computed(() => position.value?.collateral)
useOperationGuard(computed(() => [borrowVault.value?.address].filter(Boolean)))
const assets = computed(() => [collateralVault.value?.asset, borrowVault.value?.asset])
const assetsLabel = usePositionPairLabel(position)
const isEligibleForLiquidation = computed(() => isPositionEligibleForLiquidation(position.value))
const getCurrentDebt = () => position.value?.borrowed || 0n

const { name } = useEulerProductOfVault(borrowVault.value?.address || '')

const walletPriceInvert = usePriceInvert(
  () => collateralVault.value?.asset.symbol,
  () => borrowVault.value?.asset.symbol,
)

const oraclePriceRatio = computed(() => {
  if (!borrowVault.value || !collateralVault.value) return null
  const collateralPrice = getCollateralOraclePrice(borrowVault.value, collateralVault.value as Vault)
  const borrowPrice = getAssetOraclePrice(borrowVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
walletPriceInvert.autoInvert(oraclePriceRatio)
const liquidationPrice = computed(() => {
  const health = nanoToValue(position.value?.health || 0n, 18)
  if (!oraclePriceRatio.value || health < 1) return null
  return oraclePriceRatio.value / health
})
const liqPriceFromHealth = (health: number | null | undefined): number | null => {
  if (!oraclePriceRatio.value || !health || health < 1 || health > 1e15) return null
  return oraclePriceRatio.value / health
}

// --- APYs ---
const collateralSupplyRewardApy = computed(() => getSupplyRewardApy(collateralVault.value?.address || ''))
const borrowRewardApy = computed(() => getBorrowRewardApy(borrowVault.value?.address || '', collateralVault.value?.address || ''))
const collateralSupplyApy = computed(() => withIntrinsicSupplyApy(
  nanoToValue(collateralVault.value?.interestRateInfo.supplyAPY || 0n, 25),
  collateralVault.value?.asset.address,
))
const borrowApy = computed(() => withIntrinsicBorrowApy(
  nanoToValue(borrowVault.value?.interestRateInfo.borrowAPY || 0n, 25),
  borrowVault.value?.asset.address,
))

const netApyGuard = createRaceGuard()
const netAPY = ref(0)
watchEffect(async () => {
  if (!position.value || !collateralVault.value || !borrowVault.value) {
    netAPY.value = 0
    return
  }
  const gen = netApyGuard.next()
  const [supplyUsd, borrowUsd] = await Promise.all([
    getAssetUsdValueOrZero(position.value.supplied || 0n, collateralVault.value, 'off-chain'),
    getAssetUsdValueOrZero(position.value.borrowed ?? 0n, borrowVault.value, 'off-chain'),
  ])
  if (netApyGuard.isStale(gen)) return
  netAPY.value = getNetAPY(
    supplyUsd,
    collateralSupplyApy.value,
    borrowUsd,
    borrowApy.value,
    collateralSupplyRewardApy.value || null,
    borrowRewardApy.value || null,
  )
})

// --- Tab composables ---
const wallet = useWalletRepay({
  position,
  borrowVault,
  collateralVault,
  formTab,
  walletBalance,
  plan,
  isSubmitting,
  isPreparing,
  clearSimulationError,
  runSimulation,
  netAPY,
  collateralSupplyApy,
  borrowApy,
  collateralSupplyRewardApy,
  borrowRewardApy,
  oraclePriceRatio,
})

const walletSwap = useWalletSwapRepay({
  position,
  borrowVault,
  collateralVault,
  formTab,
  plan,
  isSubmitting,
  isPreparing,
  clearSimulationError,
  runSimulation,
  netAPY,
  collateralSupplyApy,
  borrowApy,
  collateralSupplyRewardApy,
  borrowRewardApy,
  oraclePriceRatio,
})

const { guardWithPriceImpact: guardWithWalletSwapPriceImpact } = usePriceImpactGate({
  directPriceImpact: walletSwap.swapPriceImpact,
})

const isWalletSwapRestricted = computed(() =>
  walletSwap.needsSwap.value && isVaultRestrictedByCountry(borrowVault.value?.address || ''),
)

const collateral = useCollateralSwapRepay({
  position,
  borrowVault,
  collateralVault,
  formTab,
  plan,
  isSubmitting,
  isPreparing,
  slippage,
  clearSimulationError,
  runSimulation,
  getCurrentDebt,
  isEligibleForLiquidation,
})

const savings = useSavingsRepay({
  position,
  borrowVault,
  collateralVault,
  formTab,
  plan,
  isSubmitting,
  isPreparing,
  slippage,
  oraclePriceRatio,
  clearSimulationError,
  runSimulation,
  getCurrentDebt,
  collateralSupplyApy,
  borrowApy,
})

const { guardWithPriceImpact: guardWithCollateralPriceImpact } = usePriceImpactGate({
  directPriceImpact: collateral.priceImpact,
})
const { guardWithPriceImpact: guardWithSavingsPriceImpact } = usePriceImpactGate({
  directPriceImpact: savings.priceImpact,
})

// --- Form tabs ---
const formTabs = computed(() => {
  const tabs = [
    { label: 'From wallet', value: 'wallet' },
    { label: 'From collateral', value: 'collateral' },
  ]
  if (savings.savingsPositions.value.length > 0) {
    tabs.push({ label: 'From savings', value: 'savings' })
  }
  return tabs
})

// --- Submit ---
const reviewRepayLabel = 'Review Repay'
const reviewRepayDisabled = computed(() => {
  if (formTab.value === 'wallet') {
    return walletSwap.needsSwap.value
      ? (isWalletSwapRestricted.value || walletSwap.isSubmitDisabled.value)
      : wallet.isSubmitDisabled.value
  }
  if (formTab.value === 'savings') return savings.isSubmitDisabled.value
  return collateral.isSubmitDisabled.value
})

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (formTab.value === 'wallet') {
    if (walletSwap.needsSwap.value) {
      if (isWalletSwapRestricted.value) return { message: 'Swapping into this vault is not available in your region', variant: 'warning' }
      if (walletSwap.disabledReason.value) return { message: walletSwap.disabledReason.value, variant: 'error' }
      if (walletSwap.estimatesError.value) return { message: walletSwap.estimatesError.value, variant: 'error' }
    }
    else {
      if (wallet.estimatesError.value) return { message: wallet.estimatesError.value, variant: 'error' }
    }
    if (simulationError.value) return { message: simulationError.value, variant: 'error' }
    return undefined
  }
  if (formTab.value === 'savings') {
    if (savings.disabledReason.value) return { message: savings.disabledReason.value, variant: savings.isRepayExceedsDebt.value ? 'error' : 'warning' }
    if (simulationError.value) return { message: simulationError.value, variant: 'error' }
    return undefined
  }
  if (collateral.disabledReason.value) return { message: collateral.disabledReason.value, variant: collateral.isRepayExceedsDebt.value ? 'error' : 'warning' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  return undefined
})

const activeHookWarning = computed(() => {
  if (formTab.value === 'wallet') {
    return walletSwap.needsSwap.value
      ? walletSwap.hookWarning.value
      : wallet.hookWarning.value
  }
  if (formTab.value === 'savings') return savings.hookWarning.value
  return collateral.hookWarning.value
})

const onSubmitForm = async () => {
  if (isOperationBlocked.value) return
  if (formTab.value === 'wallet') {
    if (walletSwap.needsSwap.value) {
      if (isWalletSwapRestricted.value) return
      await guardWithWalletSwapPriceImpact(() => walletSwap.submit())
    }
    else {
      await wallet.submit()
    }
  }
  else if (formTab.value === 'savings') {
    await guardWithSavingsPriceImpact(() => savings.submit())
  }
  else {
    await guardWithCollateralPriceImpact(() => collateral.submit())
  }
}

const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

const openWalletSwapTokenSelector = () => {
  modal.open(SwapTokenSelector, {
    props: {
      currentAssetAddress: walletSwap.selectedAsset.value?.address || borrowVault.value?.asset.address,
      onSelect: walletSwap.onSelectSwapAsset,
      allowNativeCurrency: true,
    },
  })
}

// --- Load / Fetch ---
const fetchWalletBalance = async () => {
  if (!isConnected.value || !borrowVault.value?.asset.address) {
    walletBalance.value = 0n
    return
  }
  walletBalance.value = await fetchSingleBalance(borrowVault.value.asset.address)
}

const load = async () => {
  if (!isConnected.value && !isSpyMode.value) {
    position.value = undefined
    return
  }
  isLoading.value = true
  await until(isPositionsLoaded).toBe(true)
  await until(isDepositsLoaded).toBe(true)

  try {
    position.value = getPositionBySubAccountIndex(+positionIndex)
    await fetchWalletBalance()
    wallet.initEstimates()
    collateral.initVault(position.value?.collateral as Vault | undefined)
    savings.initVault()
  }
  catch (e) {
    showError('Unable to load Vault')
    console.warn(e)
  }
  finally {
    isLoading.value = false
  }
}

// --- Watchers ---
watch(isPositionsLoaded, (val) => {
  if (val) load()
}, { immediate: true })

watch(isConnected, () => {
  fetchWalletBalance()
})

watch(address, () => {
  fetchWalletBalance()
})

watch(formTab, () => {
  clearSimulationError()
  wallet.resetOnTabSwitch()
  walletSwap.resetOnTabSwitch()
  collateral.resetOnTabSwitch()
  savings.resetOnTabSwitch()
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
      :loading="isLoading || isPositionsLoading"
      title="Repay position"
      description="Reduce your debt using tokens from your wallet, collateral, or savings."
      @submit.prevent="onSubmitForm"
    >
      <div v-if="!isConnected && !isSpyMode">
        Connect your wallet to see your positions
      </div>

      <div v-else-if="!position">
        Position not found
      </div>

      <template v-else>
        <VaultLabelsAndAssets
          :vault="position.borrow"
          :assets="assets as VaultAsset[]"
          :assets-label="assetsLabel"
          size="large"
        />

        <UiTabs
          v-model="formTab"
          class="mb-12"
          rounded
          pills
          :list="formTabs"
        />

        <UiToast
          v-if="activeHookWarning"
          :title="activeHookWarning.title"
          :description="activeHookWarning.message"
          variant="error"
          size="compact"
          class="mb-16"
        />

        <template v-if="formTab === 'wallet'">
          <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
            <div class="flex flex-col gap-16 w-full">
              <!-- Direct repay (no swap) -->
              <template v-if="!walletSwap.needsSwap.value">
                <AssetInput
                  v-if="position.borrow.asset"
                  v-model="wallet.amount.value"
                  label="Pay from wallet"
                  :desc="name"
                  :asset="position.borrow.asset"
                  :vault="position.borrow"
                  :balance="walletBalance"
                  :max-handler="wallet.onSourceMax"
                  maxable
                />

                <AssetInput
                  v-if="position.borrow.asset"
                  v-model="wallet.amount.value"
                  label="Debt to repay"
                  :asset="position.borrow.asset"
                  :vault="position.borrow"
                  :balance="position.borrowed"
                  maxable
                />

                <UiRange
                  v-if="borrowVault"
                  v-model="wallet.walletRepayPercent.value"
                  label="Percent of debt to repay"
                  :min="0"
                  :max="100"
                  :step="1"
                  :number-filter="(n: number) => `${n}%`"
                  @update:model-value="wallet.onWalletRepayPercentInput"
                />
              </template>

              <!-- Swap + repay -->
              <template v-else>
                <AssetInput
                  v-if="walletSwap.selectedAsset.value"
                  v-model="walletSwap.amount.value"
                  label="Pay from wallet"
                  :asset="walletSwap.selectedAsset.value"
                  :balance="walletSwap.selectedAssetBalance.value"
                  :max-handler="walletSwap.onSourceMax"
                  maxable
                  @update:model-value="walletSwap.onAmountInput"
                />

                <AssetInput
                  v-if="position.borrow.asset"
                  v-model="walletSwap.debtAmount.value"
                  label="Debt to repay"
                  :asset="position.borrow.asset"
                  :vault="position.borrow"
                  :balance="position.borrowed"
                  maxable
                  @update:model-value="walletSwap.onDebtInput"
                />

                <UiRange
                  v-if="borrowVault"
                  v-model="walletSwap.debtPercent.value"
                  label="Percent of debt to repay"
                  :min="0"
                  :max="100"
                  :step="1"
                  :number-filter="(n: number) => `${n}%`"
                  @update:model-value="walletSwap.onPercentInput"
                />
              </template>

              <!-- Pay with token selector -->
              <div class="flex items-center gap-8">
                <span class="text-p3 text-content-tertiary">Pay with</span>
                <button
                  type="button"
                  class="flex items-center gap-6 bg-card text-p3 font-semibold px-12 h-36 rounded-[40px] whitespace-nowrap"
                  @click="openWalletSwapTokenSelector"
                >
                  <AssetAvatar
                    :asset="{ address: walletSwap.selectedAsset.value?.address || position.borrow.asset?.address || '', symbol: walletSwap.selectedAsset.value?.symbol || position.borrow.asset?.symbol || '' }"
                    size="20"
                  />
                  {{ walletSwap.selectedAsset.value?.symbol || position.borrow.asset?.symbol }}
                  <SvgIcon
                    class="text-content-tertiary !w-16 !h-16"
                    name="arrow-down"
                  />
                </button>
              </div>

              <!-- Swap route selector (only when swapping) -->
              <SwapRouteSelector
                v-if="walletSwap.needsSwap.value"
                :items="walletSwap.swapRouteItems.value"
                :selected-provider="walletSwap.quotes.selectedProvider.value"
                :status-label="walletSwap.quotes.statusLabel.value"
                :is-loading="walletSwap.quotes.isLoading.value"
                empty-message="Enter amount to fetch quotes"
                @select="walletSwap.quotes.selectProvider"
                @refresh="walletSwap.onRefreshSwapQuotes"
              />

              <UiToast
                v-if="isWalletSwapRestricted"
                title="Swap restricted"
                description="Swapping into this vault is not available in your region. You can repay with the vault's underlying asset directly."
                variant="warning"
                size="compact"
              />
              <UiToast
                v-if="walletSwap.needsSwap.value && !isWalletSwapRestricted && walletSwap.disabledReason.value"
                title="Error"
                variant="error"
                :description="walletSwap.disabledReason.value"
                size="compact"
              />
              <UiToast
                v-show="walletSwap.needsSwap.value ? walletSwap.estimatesError.value : wallet.estimatesError.value"
                title="Error"
                variant="error"
                :description="walletSwap.needsSwap.value ? walletSwap.estimatesError.value : wallet.estimatesError.value"
                size="compact"
              />
              <UiToast
                v-if="walletSwap.needsSwap.value && walletSwap.quotes.quoteError.value"
                title="Swap quote"
                variant="warning"
                :description="walletSwap.quotes.quoteError.value"
                size="compact"
              />
              <UiToast
                v-if="simulationError"
                title="Error"
                variant="error"
                :description="simulationError"
                size="compact"
              />
            </div>

            <VaultFormInfoBlock
              v-if="collateralVault && borrowVault"
              :loading="walletSwap.needsSwap.value ? walletSwap.isEstimatesLoading.value : wallet.isEstimatesLoading.value"
              variant="card"
              class="w-full laptop:max-w-[360px]"
            >
              <SummaryRow label="Net APY">
                <SummaryValue
                  :before="formatNumber(netAPY)"
                  :after="formatNumber(walletSwap.needsSwap.value ? walletSwap.estimateNetAPY.value : wallet.estimateNetAPY.value)"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="Oracle price">
                <SummaryPriceValue
                  :value="oraclePriceRatio != null ? formatSmartAmount(walletPriceInvert.invertValue(oraclePriceRatio)!) : undefined"
                  :symbol="walletPriceInvert.displaySymbol"
                  invertible
                  @invert="walletPriceInvert.toggle"
                />
              </SummaryRow>
              <SummaryRow label="Liq. price">
                <SummaryPriceValue
                  :before="walletPriceInvert.invertValue(liquidationPrice) != null ? formatSmartAmount(walletPriceInvert.invertValue(liquidationPrice)!) : undefined"
                  :after="walletPriceInvert.invertValue(liqPriceFromHealth(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value), 18))) != null
                    ? formatSmartAmount(walletPriceInvert.invertValue(liqPriceFromHealth(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value), 18)))!)
                    : undefined"
                  :symbol="walletPriceInvert.displaySymbol"
                  invertible
                  @invert="walletPriceInvert.toggle"
                />
              </SummaryRow>
              <SummaryRow label="Liq. buffer">
                <SummaryValue
                  :before="formatLiqBuffer(walletPriceInvert.invertValue(oraclePriceRatio), walletPriceInvert.invertValue(liquidationPrice))"
                  :after="formatLiqBuffer(
                    walletPriceInvert.invertValue(oraclePriceRatio),
                    walletPriceInvert.invertValue(liqPriceFromHealth(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value), 18))),
                  )"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="LTV">
                <SummaryValue
                  :before="formatNumber(nanoToValue(position.userLTV, 18))"
                  :after="formatNumber(nanoToValue(walletSwap.needsSwap.value ? walletSwap.estimateUserLTV.value : wallet.estimateUserLTV.value, 18))"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="Health score">
                <SummaryValue
                  :before="formatHealthScore(nanoToValue(position.health, 18))"
                  :after="formatHealthScore(nanoToValue(walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value, 18))"
                />
              </SummaryRow>
              <SwapDetailsSummary
                v-if="walletSwap.needsSwap.value && (walletSwap.swapEstimatedOutput.value || walletSwap.quotes.quoteError.value)"
                :input-display="walletSwap.swapInputDisplay.value"
                :output-display="walletSwap.swapOutputDisplay.value"
                :price-impact="walletSwap.swapPriceImpact.value"
                :slippage="slippage"
                :routed-via="walletSwap.swapRoutedVia.value"
                @open-slippage-settings="openSlippageSettings"
              />
            </VaultFormInfoBlock>

            <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
              <VaultFormInfoButton
                :pair="position"
                :disabled="isLoading || isSubmitting"
              >
                Pair information
              </VaultFormInfoButton>
              <VaultFormSubmit
                :disabled="reviewRepayDisabled"
                :loading="isSubmitting || isPreparing"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
              >
                {{ reviewRepayLabel }}
              </VaultFormSubmit>
            </div>
          </div>
        </template>

        <template v-else-if="formTab === 'collateral'">
          <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
            <div class="flex flex-col gap-16 w-full">
              <UiToast
                v-if="isEligibleForLiquidation"
                title="Position in violation"
                variant="warning"
                description="This position is eligible for liquidation. Collateral swaps that don't fully clear the debt will fail. If repaying partially, consider repaying from your wallet instead."
                size="compact"
              />

              <AssetInput
                v-if="collateral.sourceVault.value"
                v-model="collateral.amount.value"
                label="Collateral to swap"
                :desc="collateral.sourceProduct.name"
                :asset="collateral.sourceVault.value.asset"
                :vault="collateral.sourceVault.value"
                :collateral-options="collateral.repayCollateralOptions.value"
                :balance="collateral.sourceBalance.value"
                :max-handler="collateral.onSourceMax"
                maxable
                @input="collateral.onAmountInput"
                @change-collateral="collateral.onSourceVaultChange"
              />
              <AssetInput
                v-if="borrowVault"
                v-model="collateral.debtAmount.value"
                label="Debt to repay"
                :desc="name"
                :asset="borrowVault.asset"
                :vault="borrowVault"
                :balance="collateral.debtBalance.value"
                maxable
                @input="collateral.onDebtInput"
              />
              <UiRange
                v-if="borrowVault"
                v-model="collateral.debtPercent.value"
                label="Percent of debt to repay"
                :min="0"
                :max="100"
                :step="1"
                :number-filter="(n: number) => `${n}%`"
                @update:model-value="collateral.onPercentInput"
              />

              <SwapRouteSelector
                v-if="!collateral.isSameAsset.value"
                :items="collateral.routeItems.value"
                :selected-provider="collateral.quotes.selectedProvider.value"
                :status-label="collateral.quotes.statusLabel.value"
                :is-loading="collateral.quotes.isLoading.value"
                :empty-message="collateral.routeEmptyMessage.value"
                @select="collateral.quotes.selectProvider"
                @refresh="collateral.onRefreshQuotes"
              />

              <UiToast
                v-if="collateral.quotes.quoteError.value && !collateral.isSameAsset.value"
                title="Swap quote"
                variant="warning"
                :description="collateral.quotes.quoteError.value"
                size="compact"
              />
              <UiToast
                v-if="collateral.isRepayExceedsDebt.value"
                title="Error"
                variant="error"
                :description="collateral.disabledReason.value"
                size="compact"
              />
              <UiToast
                v-if="!collateral.isRepayExceedsDebt.value && collateral.disabledReason.value"
                title="Cannot submit"
                variant="warning"
                :description="collateral.disabledReason.value"
                size="compact"
              />
              <UiToast
                v-if="simulationError"
                title="Error"
                variant="error"
                :description="simulationError"
                size="compact"
              />
            </div>

            <VaultFormInfoBlock
              :loading="!collateral.isSameAsset.value && collateral.quotes.isLoading.value"
              variant="card"
              class="w-full laptop:max-w-[360px]"
            >
              <SummaryRow label="ROE">
                <SummaryValue
                  :before="collateral.roeBefore.value !== null ? formatNumber(collateral.roeBefore.value) : undefined"
                  :after="collateral.roeAfter.value !== null && (collateral.quotes.quote.value || collateral.isSameAsset.value) ? formatNumber(collateral.roeAfter.value) : undefined"
                  suffix="%"
                />
              </SummaryRow>
              <template v-if="!collateral.isSameAsset.value">
                <SummaryRow
                  label="Swap price"
                  align-top
                >
                  <SummaryPriceValue
                    :value="collateral.currentPrice.value ? formatSmartAmount(collateral.priceInvert.invertValue(collateral.currentPrice.value.value)) : undefined"
                    :symbol="collateral.priceInvert.displaySymbol"
                    invertible
                    @invert="collateral.priceInvert.toggle"
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
              <SummaryRow label="Liq. price">
                <SummaryPriceValue
                  :before="collateral.currentLiquidationPrice.value !== null ? formatSmartAmount(collateral.priceInvert.invertValue(collateral.currentLiquidationPrice.value)) : undefined"
                  :after="collateral.nextLiquidationPrice.value !== null && (collateral.quotes.quote.value || collateral.isSameAsset.value) ? formatSmartAmount(collateral.priceInvert.invertValue(collateral.nextLiquidationPrice.value)) : undefined"
                  :symbol="collateral.priceInvert.displaySymbol"
                  invertible
                  @invert="collateral.priceInvert.toggle"
                />
              </SummaryRow>
              <SummaryRow label="Liq. buffer">
                <SummaryValue
                  :before="formatLiqBuffer(collateral.priceInvert.invertValue(collateral.priceRatio.value), collateral.priceInvert.invertValue(collateral.currentLiquidationPrice.value))"
                  :after="collateral.nextLiquidationPrice.value !== null && (collateral.quotes.quote.value || collateral.isSameAsset.value)
                    ? formatLiqBuffer(collateral.priceInvert.invertValue(collateral.priceRatio.value), collateral.priceInvert.invertValue(collateral.nextLiquidationPrice.value))
                    : undefined"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="LTV">
                <SummaryValue
                  :before="collateral.currentLtv.value !== null ? formatNumber(collateral.currentLtv.value) : undefined"
                  :after="collateral.nextLtv.value !== null && (collateral.quotes.quote.value || collateral.isSameAsset.value) ? formatNumber(collateral.nextLtv.value) : undefined"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="Health score">
                <SummaryValue
                  :before="collateral.currentHealth.value !== null ? formatHealthScore(collateral.currentHealth.value) : undefined"
                  :after="collateral.nextHealth.value !== null && (collateral.quotes.quote.value || collateral.isSameAsset.value) ? formatHealthScore(collateral.nextHealth.value) : undefined"
                />
              </SummaryRow>
              <SwapDetailsSummary
                v-if="!collateral.isSameAsset.value"
                :input-display="collateral.summary.value?.from ?? null"
                :output-display="collateral.summary.value?.to ?? null"
                :price-impact="collateral.priceImpact.value"
                :slippage="slippage"
                :routed-via="collateral.routedVia.value"
                @open-slippage-settings="openSlippageSettings"
              />
            </VaultFormInfoBlock>

            <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
              <VaultFormInfoButton
                :pair="position"
                :disabled="isLoading || isSubmitting"
              >
                Pair information
              </VaultFormInfoButton>
              <VaultFormSubmit
                :disabled="reviewRepayDisabled"
                :loading="isSubmitting || isPreparing"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
              >
                {{ reviewRepayLabel }}
              </VaultFormSubmit>
            </div>
          </div>
        </template>

        <template v-else-if="formTab === 'savings'">
          <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
            <div class="flex flex-col gap-16 w-full">
              <AssetInput
                v-if="savings.sourceVault.value"
                v-model="savings.amount.value"
                label="Savings to use"
                :desc="savings.sourceProduct.name"
                :asset="savings.sourceVault.value.asset"
                :vault="savings.sourceVault.value"
                :collateral-options="savings.savingsOptions.value"
                :balance="savings.sourceBalance.value"
                :max-handler="savings.onSourceMax"
                maxable
                @input="savings.onAmountInput"
                @change-collateral="savings.onSourceVaultChange"
              />
              <AssetInput
                v-if="borrowVault"
                v-model="savings.debtAmount.value"
                label="Debt to repay"
                :desc="name"
                :asset="borrowVault.asset"
                :vault="borrowVault"
                :balance="savings.debtBalance.value"
                maxable
                @input="savings.onDebtInput"
              />
              <UiRange
                v-if="borrowVault"
                v-model="savings.debtPercent.value"
                label="Percent of debt to repay"
                :min="0"
                :max="100"
                :step="1"
                :number-filter="(n: number) => `${n}%`"
                @update:model-value="savings.onPercentInput"
              />

              <SwapRouteSelector
                v-if="!savings.isSameAsset.value"
                :items="savings.routeItems.value"
                :selected-provider="savings.quotes.selectedProvider.value"
                :status-label="savings.quotes.statusLabel.value"
                :is-loading="savings.quotes.isLoading.value"
                :empty-message="savings.routeEmptyMessage.value"
                @select="savings.quotes.selectProvider"
                @refresh="savings.onRefreshQuotes"
              />

              <UiToast
                v-if="savings.quotes.quoteError.value && !savings.isSameAsset.value"
                title="Swap quote"
                variant="warning"
                :description="savings.quotes.quoteError.value"
                size="compact"
              />
              <UiToast
                v-if="savings.isRepayExceedsDebt.value"
                title="Error"
                variant="error"
                :description="savings.disabledReason.value"
                size="compact"
              />
              <UiToast
                v-if="!savings.isRepayExceedsDebt.value && savings.disabledReason.value"
                title="Cannot submit"
                variant="warning"
                :description="savings.disabledReason.value"
                size="compact"
              />
              <UiToast
                v-if="simulationError"
                title="Error"
                variant="error"
                :description="simulationError"
                size="compact"
              />
            </div>

            <VaultFormInfoBlock
              :loading="!savings.isSameAsset.value && savings.quotes.isLoading.value"
              variant="card"
              class="w-full laptop:max-w-[360px]"
            >
              <SummaryRow label="ROE">
                <SummaryValue
                  :before="savings.roeBefore.value !== null ? formatNumber(savings.roeBefore.value) : undefined"
                  :after="savings.roeAfter.value !== null && (savings.quotes.quote.value || savings.isSameAsset.value) ? formatNumber(savings.roeAfter.value) : undefined"
                  suffix="%"
                />
              </SummaryRow>
              <template v-if="!savings.isSameAsset.value">
                <SummaryRow
                  label="Swap price"
                  align-top
                >
                  <SummaryPriceValue
                    :value="savings.currentPrice.value ? formatSmartAmount(savings.priceInvert.invertValue(savings.currentPrice.value.value)) : undefined"
                    :symbol="savings.priceInvert.displaySymbol"
                    invertible
                    @invert="savings.priceInvert.toggle"
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
              <SummaryRow label="Liq. price">
                <SummaryPriceValue
                  :before="savings.currentLiquidationPrice.value !== null ? formatSmartAmount(walletPriceInvert.invertValue(savings.currentLiquidationPrice.value)) : undefined"
                  :after="savings.nextLiquidationPrice.value !== null && (savings.quotes.quote.value || savings.isSameAsset.value) ? formatSmartAmount(walletPriceInvert.invertValue(savings.nextLiquidationPrice.value)) : undefined"
                  :symbol="walletPriceInvert.displaySymbol"
                  invertible
                  @invert="walletPriceInvert.toggle"
                />
              </SummaryRow>
              <SummaryRow label="Liq. buffer">
                <SummaryValue
                  :before="formatLiqBuffer(walletPriceInvert.invertValue(oraclePriceRatio), walletPriceInvert.invertValue(savings.currentLiquidationPrice.value))"
                  :after="savings.nextLiquidationPrice.value !== null && (savings.quotes.quote.value || savings.isSameAsset.value)
                    ? formatLiqBuffer(walletPriceInvert.invertValue(oraclePriceRatio), walletPriceInvert.invertValue(savings.nextLiquidationPrice.value))
                    : undefined"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="LTV">
                <SummaryValue
                  :before="savings.currentLtv.value !== null ? formatNumber(savings.currentLtv.value) : undefined"
                  :after="savings.nextLtv.value !== null && (savings.quotes.quote.value || savings.isSameAsset.value) ? formatNumber(savings.nextLtv.value) : undefined"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="Health score">
                <SummaryValue
                  :before="savings.currentHealth.value !== null ? formatHealthScore(savings.currentHealth.value) : undefined"
                  :after="savings.nextHealth.value !== null && (savings.quotes.quote.value || savings.isSameAsset.value) ? formatHealthScore(savings.nextHealth.value) : undefined"
                />
              </SummaryRow>
              <SwapDetailsSummary
                v-if="!savings.isSameAsset.value"
                :input-display="savings.summary.value?.from ?? null"
                :output-display="savings.summary.value?.to ?? null"
                :price-impact="savings.priceImpact.value"
                :slippage="slippage"
                :routed-via="savings.routedVia.value"
                @open-slippage-settings="openSlippageSettings"
              />
            </VaultFormInfoBlock>

            <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
              <VaultFormInfoButton
                :pair="position"
                :disabled="isLoading || isSubmitting"
              >
                Pair information
              </VaultFormInfoButton>
              <VaultFormSubmit
                :disabled="reviewRepayDisabled"
                :loading="isSubmitting || isPreparing"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
              >
                {{ reviewRepayLabel }}
              </VaultFormSubmit>
            </div>
          </div>
        </template>
      </template>
    </VaultForm>
  </div>
</template>
