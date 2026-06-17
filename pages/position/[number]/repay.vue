<script setup lang="ts">
import { isEVault, type EVault, type PortfolioBorrowPosition, type SecuritizeCollateralVault, type TransactionPlan, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { maxUint256, type Address } from 'viem'
import type { VaultAsset } from '~/types/asset'
import { getNetAPY } from '~/utils/vault/apy'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { getAssetUsdValueOrZero, getCollateralOraclePrice, getAssetOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { useModal } from '~/components/ui/composables/useModal'
import { SlippageSettingsModal, SwapTokenSelector } from '#components'
import { nanoToValue } from '~/utils/crypto-utils'
import { createRaceGuard } from '~/utils/race-guard'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { isVaultRestrictedByCountry, isAssetBlockedByCountry } from '~/composables/useGeoBlock'
import { useWalletRepay } from '~/composables/repay/useWalletRepay'
import { useWalletSwapRepay } from '~/composables/repay/useWalletSwapRepay'
import { useCollateralSwapRepay } from '~/composables/repay/useCollateralSwapRepay'
import { useSavingsRepay } from '~/composables/repay/useSavingsRepay'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { areRoeCollateralVaultsCorrelatedWithBorrow, resolvePositionRoeCollateralVaults } from '~/utils/position-roe'
import { isCowProvider } from '~/entities/cowswap'

const _route = useRoute()
const _router = useRouter()
const modal = useModal()
const { isConnected } = useWagmi()
const { isSpyMode } = useSpyMode()
// Page uses SwapTokenSelector — opt into full wallet-token balance fetch while mounted.
useFullBalances()
const positionIndex = usePositionIndex()
const { planRepayFromWallet } = useEulerTx()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { isPositionsLoading, isPositionsLoaded, isDepositsLoaded, refreshAllPositions: _refreshAllPositions, getPositionBySubAccountIndex, portfolioAddress } = useEulerAccount()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { getTokenCategoryTags } = useTokenList()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { eulerLensAddresses: _eulerLensAddresses } = useEulerAddresses()
const { getBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const { slippage } = useSlippage({
  fromSymbol: () => {
    if (formTab.value === 'wallet') return walletSwap.selectedAsset.value?.symbol
    if (formTab.value === 'savings') return savings.sourceVault.value?.asset.symbol
    return collateral.sourceVault.value?.asset.symbol
  },
  toSymbol: () => borrowVault.value?.asset.symbol,
})
// --- Shared state ---
const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const formTab = ref<'wallet' | 'collateral' | 'savings'>('wallet')
const plan = ref<TransactionPlan | null>(null)
// Layer-aware: `getPositionBySubAccountIndex` reads the active batch layer's
// portfolio, so the form's debt/collateral reflect the simulated state (e.g. a
// repay added to the batch shows the reduced debt). Must be a computed, not a
// one-shot ref, or it would freeze at the layer-0 (real) snapshot.
const position = computed<PortfolioBorrowPosition<VaultEntity> | undefined>(() => {
  if (!isConnected.value && !isSpyMode.value) return undefined
  return getPositionBySubAccountIndex(+positionIndex)
})

// --- Shared computeds ---
const borrowVault = computed<EVault | undefined>(() => position.value ? position.value.borrowVault as EVault | undefined : undefined)
// Wallet balance of the debt asset from the central (layer-aware) wallet entity.
const walletBalance = computed(() => borrowVault.value?.asset.address ? getBalance(borrowVault.value.asset.address as Address) : 0n)
const collateralVault = computed<EVault | SecuritizeCollateralVault | undefined>(() => position.value ? position.value.collateralVault as EVault | SecuritizeCollateralVault | undefined : undefined)
const positionCollateralVaults = computed(() =>
  resolvePositionRoeCollateralVaults(position.value, collateralVault.value),
)
useOperationGuard(computed(() => [borrowVault.value?.address].filter(Boolean)))
const assets = computed<VaultAsset[]>(() => [collateralVault.value?.asset, borrowVault.value?.asset].filter((asset): asset is VaultAsset => !!asset))
const assetsLabel = usePositionPairLabel(position)
const isEligibleForLiquidation = computed(() => position.value?.liquidatable ?? false)
const getCurrentDebt = () => position.value?.borrowed || 0n

const { name } = useEulerProductOfVault(borrowVault.value?.address || '')

const walletPriceInvert = usePriceInvert(
  () => collateralVault.value?.asset.symbol,
  () => borrowVault.value?.asset.symbol,
)

const oraclePriceRatio = computed(() => {
  if (!borrowVault.value || !collateralVault.value) return null
  const collateralPrice = getCollateralOraclePrice(borrowVault.value, collateralVault.value as EVault)
  const borrowPrice = getAssetOraclePrice(borrowVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
walletPriceInvert.autoInvert(oraclePriceRatio)
const liquidationPrice = computed(() => {
  const healthValue = position.value?.healthFactor ?? 0n
  const health = nanoToValue(healthValue, 18)
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
const collateralSupplyApy = computed(() => withVaultIntrinsicApy(
  getVaultSupplyApy(collateralVault.value),
  collateralVault.value,
  enableIntrinsicApy.value,
))
const borrowApy = computed(() => withVaultIntrinsicApy(
  getVaultBorrowApy(borrowVault.value),
  borrowVault.value,
  enableIntrinsicApy.value,
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
  slippage,
  clearSimulationError,
  runSimulation,
  netAPY,
  collateralSupplyApy,
  borrowApy,
  collateralSupplyRewardApy,
  borrowRewardApy,
  oraclePriceRatio,
})

// Add the current repay (any tab) to the batch. CoW orders can't be merged
// into an EVC batch, so swap routes via CoW are excluded.
const canAddToBatch = computed(() => {
  if (!borrowVault.value || !position.value) return false
  if (reviewRepayDisabled.value) return false
  if (formTab.value === 'wallet') {
    if (!(+wallet.amount.value) && !(+walletSwap.amount.value)) return false
    if (walletSwap.needsSwap.value) {
      return !!walletSwap.quotes.selectedQuote.value && !isCowProvider(walletSwap.quotes.selectedProvider.value)
    }
    return !!(+wallet.amount.value)
  }
  if (formTab.value === 'collateral') {
    if (!collateral.sourceVault.value || !(+collateral.amount.value || +collateral.debtAmount.value)) return false
    if (collateral.isSameAsset.value) return true
    return !!collateral.quotes.selectedQuote.value && !isCowProvider(collateral.quotes.selectedProvider.value)
  }
  if (formTab.value === 'savings') {
    if (!savings.sourceVault.value || !(+savings.amount.value || +savings.debtAmount.value)) return false
    if (savings.isSameAsset.value) return true
    return !!savings.quotes.selectedQuote.value && !isCowProvider(savings.quotes.selectedProvider.value)
  }
  return false
})

// A full repay closes the position: the plan's cleanup moves the remaining
// collateral shares to the owner account, so the position card the user was on
// becomes a removed ghost. Land on the owner's deposit of the collateral vault
// (where that collateral now lives) instead of the ghost.
const redirectAfterRepayAdd = (isClosing: boolean) => {
  if (isClosing && portfolioAddress.value) {
    redirectAfterAdd('/portfolio/saving', {
      subAccount: portfolioAddress.value,
      vault: collateralVault.value?.address,
    })
    return
  }
  redirectAfterAdd('/portfolio', { subAccount: position.value?.subAccount })
}

const addToBatch = async () => {
  if (!canAddToBatch.value || !borrowVault.value || !position.value) return
  const borrowSymbol = borrowVault.value.asset.symbol

  if (formTab.value === 'wallet') {
    if (walletSwap.needsSwap.value) {
      const quote = walletSwap.quotes.selectedQuote.value ?? undefined
      const swapAsset = walletSwap.selectedAsset.value
      const swapAmount = walletSwap.amount.value
      const swapDirection = walletSwap.direction.value
      const inSymbol = walletSwap.selectedAsset.value?.symbol ?? ''
      const isClosing = walletSwap.isFullRepay.value
      if (!swapAsset) return
      await addBatchEntry({
        label: `Repay-swap ${inSymbol} → ${borrowSymbol}`,
        buildPlan: account => walletSwap.buildRepayPlan(quote, account, {
          selectedAsset: swapAsset,
          direction: swapDirection,
          isFullRepay: isClosing,
        }),
        subAccount: position.value.subAccount as Address,
        nameOverride: `Repay ${borrowSymbol}`,
        review: { type: 'repay', asset: swapAsset, amount: swapAmount, swapToAsset: borrowVault.value.asset },
      })
      walletSwap.amount.value = ''
      redirectAfterRepayAdd(isClosing)
      return
    }
    const liabilityVault = borrowVault.value.address as Address
    const amountNano = valueToNano(wallet.amount.value, borrowVault.value.asset.decimals)
    const currentDebt = position.value.borrowed || 0n
    const isFullRepay = amountNano >= currentDebt || wallet.walletRepayPercent.value >= 100
    const receiver = position.value.subAccount as Address
    await addBatchEntry({
      label: `Repay ${wallet.amount.value} ${borrowSymbol}`,
      buildPlan: account => planRepayFromWallet({
        liabilityVault,
        liabilityAmount: isFullRepay ? maxUint256 : amountNano,
        receiver,
        cleanupOnMax: isFullRepay,
        account,
      }),
      subAccount: position.value.subAccount as Address,
      review: { type: 'repay', asset: borrowVault.value.asset, amount: wallet.amount.value },
    })
    wallet.amount.value = ''
    redirectAfterRepayAdd(isFullRepay)
    return
  }

  if (formTab.value === 'collateral') {
    const quote = collateral.isSameAsset.value ? undefined : collateral.quotes.selectedQuote.value ?? undefined
    const sourceVault = collateral.sourceVault.value
    const sourceAmount = collateral.amount.value
    const sourceDebtAmount = collateral.debtAmount.value
    const sourceDirection = collateral.direction.value
    const isSameAsset = collateral.isSameAsset.value
    const srcSymbol = sourceVault?.asset.symbol ?? ''
    const isClosing = collateral.isFullRepay.value
    if (!sourceVault) return
    await addBatchEntry({
      label: `Repay from ${srcSymbol} collateral → ${borrowSymbol}`,
      buildPlan: account => collateral.buildRepayPlan(quote, account, {
        sourceVault,
        amount: sourceAmount,
        debtAmount: sourceDebtAmount,
        direction: sourceDirection,
        isSameAsset,
      }),
      subAccount: position.value.subAccount as Address,
      review: { type: 'repay', asset: sourceVault.asset, amount: sourceAmount, swapToAsset: borrowVault.value.asset },
    })
    collateral.amount.value = ''
    collateral.debtAmount.value = ''
    redirectAfterRepayAdd(isClosing)
    return
  }

  if (formTab.value === 'savings') {
    const quote = savings.isSameAsset.value ? undefined : savings.quotes.selectedQuote.value ?? undefined
    const sourceVault = savings.sourceVault.value
    const sourceSubAccount = savings.selectedSavingSubAccount.value
    const sourceAmount = savings.amount.value
    const sourceDebtAmount = savings.debtAmount.value
    const sourceDirection = savings.direction.value
    const isSameAsset = savings.isSameAsset.value
    const srcSymbol = sourceVault?.asset.symbol ?? ''
    const isClosing = savings.isFullRepay.value
    if (!sourceVault) return
    await addBatchEntry({
      label: `Repay from ${srcSymbol} savings → ${borrowSymbol}`,
      buildPlan: account => savings.buildRepayPlan(quote, account, {
        sourceVault,
        sourceSubAccount,
        amount: sourceAmount,
        debtAmount: sourceDebtAmount,
        direction: sourceDirection,
        isSameAsset,
      }),
      subAccount: position.value.subAccount as Address,
      review: { type: 'repay', asset: sourceVault.asset, amount: sourceAmount, swapToAsset: borrowVault.value.asset },
    })
    savings.amount.value = ''
    savings.debtAmount.value = ''
    redirectAfterRepayAdd(isClosing)
  }
}

const { guardWithPriceImpact: guardWithWalletSwapPriceImpact } = usePriceImpactGate({
  directPriceImpact: walletSwap.swapPriceImpact,
  shouldGateUnknown: computed(() =>
    walletSwap.needsSwap.value
    && walletSwap.quotes.selectedQuote.value !== null
    && walletSwap.swapPriceImpact.value === null,
  ),
})

const isWalletSwapRestricted = computed(() =>
  walletSwap.needsSwap.value && isVaultRestrictedByCountry(
    borrowVault.value?.address || '',
    { counterpart: walletSwap.selectedAsset.value },
  ),
)

// Pay-with asset can be an arbitrary ERC-20 not tied to any vault, so the
// vault-level geo-check above can't see it. Hard-block the asset directly.
// Soft-restrict does not apply: pay-with reduces exposure to that asset.
// Pass the asset object (not just address) so symbol/name pattern rules apply.
const isPayWithAssetBlocked = computed(() =>
  walletSwap.needsSwap.value && isAssetBlockedByCountry(walletSwap.selectedAsset.value),
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

const isPositionRoeApplicable = computed(() =>
  positionCollateralVaults.value.isComplete
  && areRoeCollateralVaultsCorrelatedWithBorrow(positionCollateralVaults.value.vaults, borrowVault.value, getTokenCategoryTags),
)
const isCollateralRepayRoeApplicable = computed(() =>
  positionCollateralVaults.value.isComplete
  && areRoeCollateralVaultsCorrelatedWithBorrow(positionCollateralVaults.value.vaults, borrowVault.value, getTokenCategoryTags),
)

const { guardWithPriceImpact: guardWithCollateralPriceImpact } = usePriceImpactGate({
  directPriceImpact: collateral.priceImpact,
  shouldGateUnknown: computed(() =>
    !collateral.isSameAsset.value
    && collateral.quotes.selectedQuote.value !== null
    && collateral.priceImpact.value === null,
  ),
})
const { guardWithPriceImpact: guardWithSavingsPriceImpact } = usePriceImpactGate({
  directPriceImpact: savings.priceImpact,
  shouldGateUnknown: computed(() =>
    !savings.isSameAsset.value
    && savings.quotes.selectedQuote.value !== null
    && savings.priceImpact.value === null,
  ),
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
      ? (isWalletSwapRestricted.value || isPayWithAssetBlocked.value || walletSwap.isSubmitDisabled.value)
      : wallet.isSubmitDisabled.value
  }
  if (formTab.value === 'savings') return savings.isSubmitDisabled.value
  return collateral.isSubmitDisabled.value
})

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (formTab.value === 'wallet') {
    if (walletSwap.needsSwap.value) {
      if (isPayWithAssetBlocked.value) return { message: 'Paying with this asset is not available in your region', variant: 'warning' }
      if (isWalletSwapRestricted.value) return { message: 'Swapping into this vault is not available in your region', variant: 'warning' }
      if (walletSwap.disabledReason.value) return { message: walletSwap.disabledReason.value, variant: 'error' }
      if (walletSwap.estimatesError.value) return { message: walletSwap.estimatesError.value, variant: 'error' }
    }
    else {
      if (wallet.estimatesError.value) return { message: wallet.estimatesError.value, variant: 'error' }
    }
    if (simulationError.value) return { message: simulationError.value, variant: 'error' }
    if (walletSwap.needsSwap.value && walletSwap.quotes.isLoading.value && +walletSwap.amount.value > 0) return { message: 'Fetching swap quotes...', variant: 'warning' }
    if (walletSwap.needsSwap.value && !walletSwap.quotes.selectedQuote.value && +walletSwap.amount.value > 0) return { message: 'Select a swap quote to continue', variant: 'warning' }
    return undefined
  }
  if (formTab.value === 'savings') {
    if (savings.disabledReason.value) return { message: savings.disabledReason.value, variant: savings.isRepayExceedsDebt.value ? 'error' : 'warning' }
    if (simulationError.value) return { message: simulationError.value, variant: 'error' }
    if (!savings.isSameAsset.value && savings.quotes.isLoading.value && (savings.amount.value || savings.debtAmount.value)) return { message: 'Fetching swap quotes...', variant: 'warning' }
    if (!savings.isSameAsset.value && !savings.quotes.selectedQuote.value && (savings.amount.value || savings.debtAmount.value)) return { message: 'Select a swap quote to continue', variant: 'warning' }
    return undefined
  }
  if (collateral.disabledReason.value) return { message: collateral.disabledReason.value, variant: collateral.isRepayExceedsDebt.value ? 'error' : 'warning' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  if (!collateral.isSameAsset.value && collateral.quotes.isLoading.value && (collateral.amount.value || collateral.debtAmount.value)) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (!collateral.isSameAsset.value && !collateral.quotes.selectedQuote.value && (collateral.amount.value || collateral.debtAmount.value)) return { message: 'Select a swap quote to continue', variant: 'warning' }
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
      if (isWalletSwapRestricted.value || isPayWithAssetBlocked.value) return
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
      pairedAsset: borrowVault.value?.asset,
    },
  })
}
const load = async () => {
  if (!isConnected.value && !isSpyMode.value) {
    return
  }
  isLoading.value = true
  await until(isPositionsLoaded).toBe(true)
  await until(isDepositsLoaded).toBe(true)

  try {
    // `position` is a layer-aware computed now; load() only drives the one-shot
    // form initialisation (estimates / vault selection) off the initial state.
    wallet.initEstimates()
    collateral.initVault(collateralVault.value && isEVault(collateralVault.value) ? collateralVault.value : undefined)
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
          :vault="borrowVault"
          :assets="assets"
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

        <UiAlert
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
                  v-if="borrowVault?.asset"
                  v-model="wallet.amount.value"
                  label="Pay from wallet"
                  :desc="name"
                  :asset="borrowVault.asset"
                  :vault="borrowVault"
                  :balance="walletBalance"
                  :max-handler="wallet.onSourceMax"
                  maxable
                />

                <AssetInput
                  v-if="borrowVault?.asset"
                  v-model="wallet.amount.value"
                  label="Debt to repay"
                  :asset="borrowVault.asset"
                  :vault="borrowVault"
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
                  v-if="borrowVault?.asset"
                  v-model="walletSwap.debtAmount.value"
                  label="Debt to repay"
                  :asset="borrowVault.asset"
                  :vault="borrowVault"
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
                    :asset="{ address: walletSwap.selectedAsset.value?.address || borrowVault?.asset.address || '', symbol: walletSwap.selectedAsset.value?.symbol || borrowVault?.asset.symbol || '' }"
                    size="20"
                  />
                  {{ walletSwap.selectedAsset.value?.symbol || borrowVault?.asset.symbol }}
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

              <UiAlert
                v-if="isPayWithAssetBlocked"
                title="Asset restricted"
                description="Paying with this asset is not available in your region. Pick a different asset."
                variant="warning"
                size="compact"
              />
              <UiAlert
                v-if="!isPayWithAssetBlocked && isWalletSwapRestricted"
                title="Swap restricted"
                description="Swapping into this vault is not available in your region. You can repay with the vault's underlying asset directly."
                variant="warning"
                size="compact"
              />
              <UiAlert
                v-if="walletSwap.needsSwap.value && !isWalletSwapRestricted && !isPayWithAssetBlocked && walletSwap.disabledReason.value"
                title="Error"
                variant="error"
                :description="walletSwap.disabledReason.value"
                size="compact"
              />
              <UiAlert
                v-show="walletSwap.needsSwap.value ? walletSwap.estimatesError.value : wallet.estimatesError.value"
                title="Error"
                variant="error"
                :description="walletSwap.needsSwap.value ? walletSwap.estimatesError.value : wallet.estimatesError.value"
                size="compact"
              />
              <UiAlert
                v-if="walletSwap.needsSwap.value && walletSwap.quotes.quoteError.value"
                title="Swap quote"
                variant="warning"
                :description="walletSwap.quotes.quoteError.value"
                size="compact"
              />
              <UiAlert
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
                  :after="walletPriceInvert.invertValue(liqPriceFromHealth(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value) ?? 0n, 18))) != null
                    ? formatSmartAmount(walletPriceInvert.invertValue(liqPriceFromHealth(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value) ?? 0n, 18)))!)
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
                    walletPriceInvert.invertValue(liqPriceFromHealth(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value) ?? 0n, 18))),
                  )"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="LTV">
                <SummaryValue
                  :before="formatNumber(ltvToPercent(nanoToValue(position.userLTV ?? position.currentLTV ?? 0n, 18)))"
                  :after="formatNumber(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateUserLTV.value : wallet.estimateUserLTV.value) ?? 0n, 18))"
                  suffix="%"
                />
              </SummaryRow>
              <SummaryRow label="Health score">
                <SummaryValue
                  :before="formatHealthScore(nanoToValue(position.healthFactor ?? 0n, 18))"
                  :after="formatHealthScore(nanoToValue((walletSwap.needsSwap.value ? walletSwap.estimateHealth.value : wallet.estimateHealth.value) ?? 0n, 18))"
                />
              </SummaryRow>
              <SwapDetailsSummary
                v-if="walletSwap.needsSwap.value && (walletSwap.swapEstimatedOutput.value || walletSwap.quotes.quoteError.value)"
                :input-display="walletSwap.swapInputDisplay.value"
                :input-exact-display="walletSwap.swapInputExactDisplay.value"
                :output-display="walletSwap.swapOutputDisplay.value"
                :output-exact-display="walletSwap.swapOutputExactDisplay.value"
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
                :can-add-to-batch="canAddToBatch"
                @add-to-batch="addToBatch"
              >
                {{ reviewRepayLabel }}
              </VaultFormSubmit>
            </div>
          </div>
        </template>

        <template v-else-if="formTab === 'collateral'">
          <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
            <div class="flex flex-col gap-16 w-full">
              <UiAlert
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
                @select="collateral.onProviderSelect"
                @refresh="collateral.onRefreshQuotes"
              />

              <UiAlert
                v-if="collateral.quotes.quoteError.value && !collateral.isSameAsset.value"
                title="Swap quote"
                variant="warning"
                :description="collateral.quotes.quoteError.value"
                size="compact"
              />
              <UiAlert
                v-if="collateral.isRepayExceedsDebt.value"
                title="Error"
                variant="error"
                :description="collateral.disabledReason.value"
                size="compact"
              />
              <UiAlert
                v-if="!collateral.isRepayExceedsDebt.value && collateral.disabledReason.value"
                title="Cannot submit"
                variant="warning"
                :description="collateral.disabledReason.value"
                size="compact"
              />
              <UiAlert
                v-if="simulationError"
                title="Error"
                variant="error"
                :description="simulationError"
                size="compact"
              />

              <VaultWarningBanner :warnings="[collateral.liquidityWarning.value]" />
            </div>

            <VaultFormInfoBlock
              :loading="!collateral.isSameAsset.value && collateral.quotes.isLoading.value"
              variant="card"
              class="w-full laptop:max-w-[360px]"
            >
              <SummaryRow
                v-if="isCollateralRepayRoeApplicable"
                label="ROE"
              >
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
                :input-exact-display="collateral.summary.value?.fromExact ?? null"
                :output-display="collateral.summary.value?.to ?? null"
                :output-exact-display="collateral.summary.value?.toExact ?? null"
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
                :can-add-to-batch="canAddToBatch"
                @add-to-batch="addToBatch"
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
                :selected-source="'vault'"
                :selected-sub-account="savings.selectedSavingSubAccount.value"
                :selected-vault-address="savings.sourceVault.value.address"
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

              <UiAlert
                v-if="savings.quotes.quoteError.value && !savings.isSameAsset.value"
                title="Swap quote"
                variant="warning"
                :description="savings.quotes.quoteError.value"
                size="compact"
              />
              <UiAlert
                v-if="savings.isRepayExceedsDebt.value"
                title="Error"
                variant="error"
                :description="savings.disabledReason.value"
                size="compact"
              />
              <UiAlert
                v-if="!savings.isRepayExceedsDebt.value && savings.disabledReason.value"
                title="Cannot submit"
                variant="warning"
                :description="savings.disabledReason.value"
                size="compact"
              />
              <UiAlert
                v-if="simulationError"
                title="Error"
                variant="error"
                :description="simulationError"
                size="compact"
              />

              <VaultWarningBanner :warnings="[savings.liquidityWarning.value]" />
            </div>

            <VaultFormInfoBlock
              :loading="!savings.isSameAsset.value && savings.quotes.isLoading.value"
              variant="card"
              class="w-full laptop:max-w-[360px]"
            >
              <SummaryRow
                v-if="isPositionRoeApplicable"
                label="ROE"
              >
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
                :input-exact-display="savings.summary.value?.fromExact ?? null"
                :output-display="savings.summary.value?.to ?? null"
                :output-exact-display="savings.summary.value?.toExact ?? null"
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
                :can-add-to-batch="canAddToBatch"
                @add-to-batch="addToBatch"
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
