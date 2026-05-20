<script setup lang="ts">
import { getAddress, formatUnits, type Address, zeroAddress } from 'viem'
import { FixedPoint } from '~/utils/fixed-point'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal, SwapTokenSelector, SlippageSettingsModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import {
  convertSharesToAssets,
  fetchSecuritizeVault,
  type Vault,
  type SecuritizeVault,
  type VaultAsset,
  getCashLimitedWithdrawAmount,
  getProjectedRates,
} from '~/entities/vault'
import { isSecuritizeVault } from '~/entities/vault/factory'
import { getSubAccountAddress } from '~/entities/account'
import { getHookDisabledWarning, getUtilisationWarning } from '~/composables/useVaultWarnings'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import type { TxPlan } from '~/entities/txPlan'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { type SwapApiQuote, SwapperMode } from '~/entities/swap'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { formatNumber, formatSmartAmount, formatExactAmount } from '~/utils/string-utils'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { isOpDisabled, OP_REDEEM, OP_WITHDRAW } from '~/utils/vault-hooks'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { isAssetBlockedByCountry, isAssetRestrictedByCountry } from '~/composables/useGeoBlock'

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { error } = useToast()
// Page uses SwapTokenSelector — opt into full wallet-token balance fetch while mounted.
useFullBalances()
const { buildWithdrawPlan, buildRedeemPlan, buildWithdrawAndSwapPlan, buildRedeemAndSwapPlan, executeTxPlan } = useEulerOperations()
const { getVault, getSecuritizeVault: _getSecuritizeVault, getEscrowVault: _getEscrowVault } = useVaults()
const { isConnected, address } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const effectiveAddress = computed(() => isSpyMode.value ? spyAddress.value : address.value)
const { fetchVaultShareBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTxPlanSimulation()
const { getSupplyRewardApy } = useRewardsApy()
const { withIntrinsicSupplyApy } = useIntrinsicApy()
const vaultAddress = route.params.vault as string
useOperationGuard([vaultAddress])
const subAccountIndex = Number(route.params.subAccount)
const subAccount = computed(() => {
  const addr = effectiveAddress.value
  if (!addr || isNaN(subAccountIndex)) return undefined
  return getSubAccountAddress(addr, subAccountIndex)
})

const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isEstimatesLoading = ref(false)
const amount = ref('')
const plan = ref<TxPlan | null>(null)
const vault: Ref<Vault | SecuritizeVault | undefined> = ref()
const asset: Ref<VaultAsset | undefined> = ref()

// Check if vault is securitize (for things like supply/borrow which securitize doesn't have)
const isSecuritizeVaultType = computed(() => vault.value && 'type' in vault.value && vault.value.type === 'securitize')

const withdrawWarnings = computed(() => {
  if (!vault.value || isSecuritizeVaultType.value) return []
  return [
    getHookDisabledWarning(vault.value as Vault, effectiveWithdrawOp.value),
    getUtilisationWarning(vault.value as Vault, 'lend'),
  ]
})
const assetsBalance = ref(0n)
const sharesBalance = ref(0n)
const delta = ref(0n)
const estimateSupplyAPY = ref(0n)
const estimatesError = ref('')

// Withdraw & swap state
const selectedOutputAsset = ref<VaultAsset | undefined>()
const isUnknownSwapToken = ref(false)
const needsSwap = computed(() => {
  if (!selectedOutputAsset.value || !asset.value) return false
  try {
    return getAddress(selectedOutputAsset.value.address) !== getAddress(asset.value.address)
  }
  catch {
    return false
  }
})
const { slippage: swapSlippage } = useSlippage({
  fromSymbol: () => asset.value?.symbol,
  toSymbol: () => selectedOutputAsset.value?.symbol,
})
const {
  sortedQuoteCards: swapQuoteCardsSorted,
  selectedProvider: swapSelectedProvider,
  selectedQuote: swapSelectedQuote,
  effectiveQuote: swapEffectiveQuote,
  effectiveQuoteFetchedAt: swapEffectiveQuoteFetchedAt,
  isLoading: isSwapQuoteLoading,
  quoteError: swapQuoteError,
  statusLabel: swapQuotesStatusLabel,
  getQuoteDiffPct: getSwapQuoteDiffPct,
  reset: resetSwapQuoteState,
  requestQuotes: requestSwapQuotes,
  selectProvider: selectSwapQuote,
} = useSwapQuotesParallel({
  amountField: 'amountOut',
  compare: 'max',
  buildTxPlanForQuote: quote => buildSwapWithdrawPlanFromQuote(quote),
})
const rewardApy = computed(() => getSupplyRewardApy(vault.value?.address || ''))
const amountFixed = computed(() => {
  return FixedPoint.fromValue(
    valueToNano(amount.value || '0', asset.value?.decimals || 0),
    Number(asset.value?.decimals || 0),
  )
})
const withdrawableAssets = computed(() => getCashLimitedWithdrawAmount(
  assetsBalance.value,
  vault.value,
))
const effectiveWithdrawOp = computed(() => {
  const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)
  return isMax ? OP_REDEEM : OP_WITHDRAW
})
const isOutputAssetBlocked = computed(() =>
  needsSwap.value && isAssetBlockedByCountry(selectedOutputAsset.value),
)
const isOutputAssetRestricted = computed(() =>
  needsSwap.value && isAssetRestrictedByCountry(selectedOutputAsset.value, { counterpart: asset.value }),
)
const isSubmitDisabled = computed(() => {
  if (!isConnected.value) return false
  if (vault.value && !isSecuritizeVaultType.value && isOpDisabled(vault.value as Vault, effectiveWithdrawOp.value)) return true
  if (isOutputAssetBlocked.value || isOutputAssetRestricted.value) return true
  if (withdrawableAssets.value < amountFixed.value.value) return true
  if (isLoading.value || amountFixed.value.isZero() || amountFixed.value.isNegative()) return true
  if (estimatesError.value) return true
  if (needsSwap.value && !swapSelectedQuote.value && !isSwapQuoteLoading.value) return true
  return false
})
const reviewWithdrawDisabled = isSubmitDisabled
const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (vault.value && !isSecuritizeVaultType.value && isOpDisabled(vault.value as Vault, effectiveWithdrawOp.value)) return { message: 'Withdrawals are currently disabled for this vault', variant: 'warning' }
  if (isOutputAssetBlocked.value || isOutputAssetRestricted.value) return { message: 'Receiving this asset is not available in your region', variant: 'warning' }
  if (estimatesError.value) return { message: estimatesError.value, variant: 'error' }
  if (!amountFixed.value.isZero() && assetsBalance.value < amountFixed.value.value) return { message: 'Insufficient balance', variant: 'error' }
  if (!amountFixed.value.isZero() && withdrawableAssets.value < amountFixed.value.value) return { message: 'Not enough liquidity in vault', variant: 'error' }
  if (needsSwap.value && isSwapQuoteLoading.value && !amountFixed.value.isZero()) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (needsSwap.value && !swapSelectedQuote.value && !amountFixed.value.isZero()) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})
const supplyAPYDisplay = computed(() => {
  if (!vault.value) return '0.00'
  const base = withIntrinsicSupplyApy(nanoToValue(vault.value.interestRateInfo.supplyAPY, 25), vault.value.asset.address)
  return formatNumber(base + rewardApy.value)
})
const estimateSupplyAPYDisplay = computed(() => {
  const base = withIntrinsicSupplyApy(nanoToValue(estimateSupplyAPY.value, 25), vault.value?.asset.address)
  return formatNumber(base + rewardApy.value)
})

// Reactive USD prices for display
const assetsBalanceUsd = ref(0)
const withdrawableAssetsUsd = ref(0)
const deltaUsd = ref(0)

// Update USD prices when vault or amounts change
watchEffect(async () => {
  if (!vault.value || isSecuritizeVaultType.value) {
    assetsBalanceUsd.value = 0
    withdrawableAssetsUsd.value = 0
    deltaUsd.value = 0
    return
  }
  assetsBalanceUsd.value = await getAssetUsdValueOrZero(assetsBalance.value, vault.value as Vault, 'off-chain')
  withdrawableAssetsUsd.value = await getAssetUsdValueOrZero(withdrawableAssets.value, vault.value as Vault, 'off-chain')
  deltaUsd.value = await getAssetUsdValueOrZero(delta.value, vault.value as Vault, 'off-chain')
})

// Swap quote helpers
const swapEstimatedOutput = computed(() => {
  if (!swapEffectiveQuote.value || !selectedOutputAsset.value) return ''
  const amountOut = BigInt(swapEffectiveQuote.value.amountOut || 0)
  if (amountOut <= 0n) return ''
  return formatUnits(amountOut, Number(selectedOutputAsset.value.decimals))
})

const swapInputDisplay = computed(() => {
  if (!swapEffectiveQuote.value || !asset.value) return ''
  const amountIn = BigInt(swapEffectiveQuote.value.amountIn || 0)
  if (amountIn <= 0n) return ''
  return `${formatSmartAmount(formatUnits(amountIn, Number(asset.value.decimals)))} ${asset.value.symbol}`
})

const swapInputExactDisplay = computed(() => {
  if (!swapEffectiveQuote.value || !asset.value) return ''
  const amountIn = BigInt(swapEffectiveQuote.value.amountIn || 0)
  if (amountIn <= 0n) return ''
  return `${formatUnits(amountIn, Number(asset.value.decimals))} ${asset.value.symbol}`
})

const swapOutputDisplay = computed(() => {
  if (!swapEffectiveQuote.value || !selectedOutputAsset.value) return ''
  const amountOut = BigInt(swapEffectiveQuote.value.amountOut || 0)
  if (amountOut <= 0n) return ''
  return `${formatSmartAmount(formatUnits(amountOut, Number(selectedOutputAsset.value.decimals)))} ${selectedOutputAsset.value.symbol}`
})

const swapOutputExactDisplay = computed(() => {
  if (!swapEffectiveQuote.value || !selectedOutputAsset.value) return ''
  const amountOut = BigInt(swapEffectiveQuote.value.amountOut || 0)
  if (amountOut <= 0n) return ''
  return `${formatUnits(amountOut, Number(selectedOutputAsset.value.decimals))} ${selectedOutputAsset.value.symbol}`
})

const swapRoutedVia = computed(() => {
  if (!swapSelectedProvider.value) return 'Not selected'
  if (!swapEffectiveQuote.value?.route?.length) return null
  return swapEffectiveQuote.value.route.map((r: { providerName: string }) => r.providerName).join(', ')
})

const { priceImpact: swapPriceImpact } = useSwapPriceImpact({
  quote: swapEffectiveQuote,
  fromVault: vault,
})

const shouldGateUnknownPriceImpact = computed(() =>
  swapEffectiveQuote.value !== null && swapPriceImpact.value === null,
)
const { guardWithPriceImpact } = usePriceImpactGate({
  directPriceImpact: swapPriceImpact,
  shouldGateUnknown: shouldGateUnknownPriceImpact,
})

const swapRouteItems = computed(() => {
  if (!selectedOutputAsset.value) return []
  return buildSwapRouteItems({
    quoteCards: swapQuoteCardsSorted.value,
    getQuoteDiffPct: getSwapQuoteDiffPct,
    decimals: Number(selectedOutputAsset.value.decimals),
    symbol: selectedOutputAsset.value.symbol,
    formatAmount: formatSmartAmount,
  })
})

async function buildSwapWithdrawPlanFromQuote(quote: SwapApiQuote): Promise<TxPlan> {
  const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)
  return isMax
    ? buildRedeemAndSwapPlan({
        vaultAddress: vaultAddress as Address,
        sharesAmount: sharesBalance.value,
        quote,
        requestedSlippage: swapSlippage.value,
        subAccount: subAccount.value,
      })
    : buildWithdrawAndSwapPlan({
        vaultAddress: vaultAddress as Address,
        assetsAmount: amountFixed.value.value,
        quote,
        requestedSlippage: swapSlippage.value,
        subAccount: subAccount.value,
      })
}

const requestSwapQuote = useDebounceFn(async () => {
  swapQuoteError.value = null

  if (!selectedOutputAsset.value || !asset.value || !needsSwap.value || !amount.value) {
    resetSwapQuoteState()
    return
  }

  const withdrawAmountNano = valueToNano(amount.value || '0', asset.value.decimals)
  if (withdrawAmountNano <= 0n) {
    resetSwapQuoteState()
    return
  }

  const userAddr = (address.value || zeroAddress) as Address
  const subAccountAddr = subAccount.value
    ? (subAccount.value as Address)
    : userAddr
  await requestSwapQuotes({
    tokenIn: asset.value.address as Address,
    tokenOut: selectedOutputAsset.value.address as Address,
    accountIn: subAccountAddr,
    accountOut: zeroAddress as Address,
    amount: withdrawAmountNano,
    vaultIn: vaultAddress as Address,
    receiver: userAddr,
    transferOutputToReceiver: true,
    slippage: swapSlippage.value,
    swapperMode: SwapperMode.EXACT_IN,
    isRepay: false,
    targetDebt: 0n,
    currentDebt: 0n,
  })
}, 500)

const onSelectOutputAsset = (newAsset: VaultAsset, meta?: { isUnknownToken?: boolean }) => {
  selectedOutputAsset.value = newAsset
  isUnknownSwapToken.value = meta?.isUnknownToken ?? false
  amount.value = ''
  clearSimulationError()
  resetSwapQuoteState()
}

const openSwapTokenSelector = () => {
  modal.open(SwapTokenSelector, {
    props: {
      currentAssetAddress: selectedOutputAsset.value?.address || asset.value?.address,
      onSelect: onSelectOutputAsset,
      mode: 'output' as const,
      pairedAsset: asset.value,
    },
  })
}

const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

const onRefreshSwapQuotes = () => {
  resetSwapQuoteState()
  requestSwapQuote()
}

const load = async () => {
  isLoading.value = true
  try {
    // Check if securitize vault first
    const isSecuritize = await isSecuritizeVault(vaultAddress)
    if (isSecuritize) {
      vault.value = await fetchSecuritizeVault(vaultAddress, buildFetchContext())
      estimateSupplyAPY.value = 0n // Securitize vaults don't have interest rate
    }
    else {
      vault.value = await getVault(vaultAddress)
      estimateSupplyAPY.value = (vault.value as Vault).interestRateInfo.supplyAPY
    }

    asset.value = vault.value?.asset

    // Always fetch fresh share balance directly from contract
    await fetchShareBalance()
    await updateBalance()
  }
  catch (e) {
    showError('Unable to load Vault')
    console.warn(e)
  }
  finally {
    isLoading.value = false
  }
}
const fetchShareBalance = async () => {
  if (!vault.value?.address) {
    sharesBalance.value = 0n
    return
  }
  sharesBalance.value = await fetchVaultShareBalance(vault.value.address, subAccount.value)
}
const updateBalance = async () => {
  if ((!isConnected.value && !isSpyMode.value) || sharesBalance.value === 0n) {
    assetsBalance.value = 0n
    delta.value = 0n
    return
  }

  // Convert shares to assets
  assetsBalance.value = await convertSharesToAssets(
    vaultAddress,
    sharesBalance.value,
  )
  delta.value = assetsBalance.value
}
const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value || isOutputAssetBlocked.value || isOutputAssetRestricted.value) return
  isPreparing.value = true
  try {
    await guardWithPriceImpact(async () => {
      if (!asset.value?.address) {
        return
      }

      const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)

      try {
        if (needsSwap.value && swapSelectedQuote.value) {
          if (isMax) {
            plan.value = await buildRedeemAndSwapPlan({
              vaultAddress: vaultAddress as Address,
              sharesAmount: sharesBalance.value,
              quote: swapSelectedQuote.value,
              requestedSlippage: swapSlippage.value,
              subAccount: subAccount.value,
            })
          }
          else {
            plan.value = await buildWithdrawAndSwapPlan({
              vaultAddress: vaultAddress as Address,
              assetsAmount: amountFixed.value.value,
              quote: swapSelectedQuote.value,
              requestedSlippage: swapSlippage.value,
              subAccount: subAccount.value,
            })
          }
        }
        else {
          plan.value = isMax
            ? await buildRedeemPlan(vaultAddress, amountFixed.value.value, sharesBalance.value, isMax, subAccount.value)
            : await buildWithdrawPlan(vaultAddress, amountFixed.value.value, subAccount.value)
        }
      }
      catch (e) {
        console.warn('[lend/withdraw] failed to build plan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value)
        if (!ok) {
          return
        }
      }

      const reviewType = needsSwap.value ? 'swap-withdraw' as const : 'withdraw' as const
      modal.open(OperationReviewModal, {
        props: {
          type: reviewType,
          asset: asset.value,
          amount: amount.value,
          plan: plan.value || undefined,
          quoteFetchedAt: needsSwap.value ? swapEffectiveQuoteFetchedAt.value : null,
          swapToAsset: needsSwap.value ? selectedOutputAsset.value : undefined,
          swapToAmount: needsSwap.value ? swapEstimatedOutput.value : undefined,
          swapMode: needsSwap.value ? SwapperMode.EXACT_IN : undefined,
          submittingLabel: 'Submitting...',
          onConfirm: async () => {
            await send()
          },
        },
      })
    })
  }
  finally {
    isPreparing.value = false
  }
}
const send = async () => {
  try {
    isSubmitting.value = true
    if (!asset.value?.address) {
      return
    }

    const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)
    let txPlan: TxPlan

    if (needsSwap.value && swapSelectedQuote.value) {
      const quote = swapSelectedQuote.value
      if (isMax) {
        txPlan = await buildRedeemAndSwapPlan({
          vaultAddress: vaultAddress as Address,
          sharesAmount: sharesBalance.value,
          quote,
          requestedSlippage: swapSlippage.value,
          subAccount: subAccount.value,
        })
      }
      else {
        txPlan = await buildWithdrawAndSwapPlan({
          vaultAddress: vaultAddress as Address,
          assetsAmount: amountFixed.value.value,
          quote,
          requestedSlippage: swapSlippage.value,
          subAccount: subAccount.value,
        })
      }
    }
    else {
      txPlan = isMax
        ? await buildRedeemPlan(vaultAddress, amountFixed.value.value, sharesBalance.value, isMax, subAccount.value)
        : await buildWithdrawPlan(vaultAddress, amountFixed.value.value, subAccount.value)
    }
    await executeTxPlan(txPlan)

    modal.close()
    setTimeout(() => {
      router.replace({ path: '/portfolio/saving', query: { network: route.query.network } })
    }, 400)
  }
  catch (e) {
    error('Transaction failed')
    console.warn(e)
  }
  finally {
    isSubmitting.value = false
  }
}
const updateSyncEstimates = () => {
  clearSimulationError()
  estimatesError.value = ''
  if (!vault.value) return
  try {
    if (assetsBalance.value < amountFixed.value.value) {
      throw new Error('Not enough balance')
    }

    if (withdrawableAssets.value < amountFixed.value.value) {
      throw new Error('Not enough liquidity in vault')
    }

    delta.value = assetsBalance.value - amountFixed.value.value
  }
  catch (e) {
    logWarn('lend-withdraw/syncEstimates', e)
    delta.value = assetsBalance.value || 0n
    estimatesError.value = (e as { message: string }).message
  }
}

const estimatesGuard = createRaceGuard()

const updateAsyncEstimates = useDebounceFn(async () => {
  if (!vault.value || isSecuritizeVaultType.value) {
    isEstimatesLoading.value = false
    return
  }
  const gen = estimatesGuard.next()
  try {
    const v = vault.value as Vault
    const amountNano = valueToNano(amount.value, v.decimals)
    const projected = await getProjectedRates(
      v.address,
      v.interestRateInfo.cash,
      v.interestRateInfo.borrows,
      -amountNano,
      0n,
    )
    if (estimatesGuard.isStale(gen)) return
    estimateSupplyAPY.value = projected?.supplyAPY ?? v.interestRateInfo.supplyAPY
  }
  catch (e) {
    if (estimatesGuard.isStale(gen)) return
    logWarn('lend-withdraw/asyncEstimates', e)
    estimateSupplyAPY.value = (vault.value as Vault)?.interestRateInfo.supplyAPY || 0n
  }
  finally {
    if (!estimatesGuard.isStale(gen)) {
      isEstimatesLoading.value = false
    }
  }
}, 500)

load()

watch([isConnected, effectiveAddress], async () => {
  if (vault.value) {
    await fetchShareBalance()
    await updateBalance()
  }
})
watch(amount, async () => {
  updateSyncEstimates()
  if (!vault.value) return
  if (!isEstimatesLoading.value) {
    isEstimatesLoading.value = true
  }
  updateAsyncEstimates()
  if (needsSwap.value) {
    resetSwapQuoteState()
    requestSwapQuote()
  }
})

// Fetch swap quotes when output asset changes
watch(selectedOutputAsset, () => {
  clearSimulationError()
  resetSwapQuoteState()
  if (needsSwap.value && amount.value) {
    requestSwapQuote()
  }
})

// Re-request quote when slippage changes
watch(swapSlippage, () => {
  if (needsSwap.value && amount.value) {
    clearSimulationError()
    resetSwapQuoteState()
    requestSwapQuote()
  }
})

watch(swapSelectedQuote, () => {
  clearSimulationError()
})
</script>

<template>
  <div class="relative">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="`/lend/${vaultAddress}`"
    />
    <VaultForm
      back
      :back-fallback="`/lend/${vaultAddress}`"
      title="Withdraw savings"
      description="Withdraw your supplied assets back to your wallet."
      class="flex flex-col gap-16"
      :loading="isLoading"
      @submit.prevent="submit"
    >
      <template v-if="vault && asset">
        <VaultLabelsAndAssets
          :vault="vault"
          :assets="[asset]"
          size="large"
        />

        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-if="asset"
              v-model="amount"
              label="Withdraw amount"
              :asset="asset"
              :vault="(vault as Vault)"
              :balance="withdrawableAssets"
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
                  :asset="{ address: selectedOutputAsset?.address || asset.address, symbol: selectedOutputAsset?.symbol || asset.symbol }"
                  size="20"
                />
                {{ selectedOutputAsset?.symbol || asset.symbol }}
                <SvgIcon
                  class="text-content-tertiary !w-16 !h-16"
                  name="arrow-down"
                />
              </button>
            </div>

            <!-- Swap info block -->
            <template v-if="needsSwap && selectedOutputAsset">
              <SwapRouteSelector
                :items="swapRouteItems"
                :selected-provider="swapSelectedProvider"
                :status-label="swapQuotesStatusLabel"
                :is-loading="isSwapQuoteLoading"
                empty-message="Enter amount to fetch quotes"
                @select="selectSwapQuote"
                @refresh="onRefreshSwapQuotes"
              />

              <VaultFormInfoBlock
                v-if="swapEstimatedOutput || swapQuoteError"
                :loading="isSwapQuoteLoading"
                variant="card"
              >
                <SwapDetailsSummary
                  :input-display="swapInputDisplay"
                  :input-exact-display="swapInputExactDisplay"
                  :output-display="swapOutputDisplay"
                  :output-exact-display="swapOutputExactDisplay"
                  :price-impact="swapPriceImpact"
                  :slippage="swapSlippage"
                  :routed-via="swapRoutedVia"
                  @open-slippage-settings="openSlippageSettings"
                />
              </VaultFormInfoBlock>

              <UiToast
                v-if="swapQuoteError"
                title="Swap quote"
                variant="warning"
                :description="swapQuoteError"
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
              v-if="isOutputAssetBlocked || isOutputAssetRestricted"
              title="Asset restricted"
              description="Receiving this asset is not available in your region. Pick a different token."
              variant="warning"
              size="compact"
            />

            <UiToast
              v-show="estimatesError"
              title="Error"
              variant="error"
              :description="estimatesError"
              size="compact"
            />
            <UiToast
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <VaultWarningBanner :warnings="withdrawWarnings" />
          </div>

          <VaultFormInfoBlock
            :loading="isEstimatesLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow label="Supply APY">
              <SummaryValue
                :before="supplyAPYDisplay"
                :after="estimateSupplyAPYDisplay"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow
              v-if="!isSecuritizeVaultType"
              label="Supplied"
            >
              <SummaryValue
                :before="`$${formatNumber(assetsBalanceUsd)}`"
                :after="amount && delta !== assetsBalance && delta >= 0n ? `$${formatNumber(deltaUsd)}` : undefined"
              />
            </SummaryRow>
            <SummaryRow label="Available for withdraw">
              <p
                v-if="asset"
                class="text-p2 flex items-center gap-4"
              >
                <UiExactAmount :exact="formatExactAmount(withdrawableAssets, asset.decimals, asset.symbol)">
                  {{ formatSmartAmount(nanoToValue(withdrawableAssets, asset.decimals)) }}
                  <span class="text-p3 text-content-tertiary">{{ asset.symbol }}</span>
                </UiExactAmount>
                <span
                  v-if="!isSecuritizeVaultType"
                  class="text-p3 text-content-tertiary"
                >≈ ${{ formatNumber(withdrawableAssetsUsd) }}</span>
              </p>
            </SummaryRow>
          </VaultFormInfoBlock>

          <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
            <VaultFormSubmit
              :loading="isSubmitting || isPreparing"
              :disabled="reviewWithdrawDisabled"
              :disabled-reason="disabledReasonInfo?.message"
              :disabled-reason-variant="disabledReasonInfo?.variant"
            >
              Review Withdraw
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
