<script setup lang="ts">
import { getSubAccountAddress, isSecuritizeCollateralVault, type EVault, type SecuritizeCollateralVault, type SwapQuote, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { VaultAsset } from '~/types/asset'
import { getProjectedRates } from '~/utils/vault/apy'
import { isSecuritizeVault } from '~/utils/vault/categories'
import { getHookDisabledWarning, getUtilisationWarning } from '~/composables/useVaultWarnings'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { formatNumber, formatSmartAmount, formatExactAmount } from '~/utils/string-utils'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { isOpDisabled, OP_REDEEM, OP_WITHDRAW } from '~/utils/vault-hooks'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { isAssetBlockedByCountry, isAssetRestrictedByCountry } from '~/composables/useGeoBlock'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { getTxErrorMessage } from '~/utils/tx-errors'
import { getAddress, formatUnits, zeroAddress, type Address } from 'viem'
import { SwapTokenSelector, SlippageSettingsModal, OperationReviewModal } from '#components'
import { FixedPoint } from '~/utils/fixed-point'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { createRaceGuard } from '~/utils/race-guard'
import { isCowProviderOrQuote } from '~/entities/cowswap'
import {
  getProjectedYieldState,
  mergeProjectedRewardCampaigns,
  type ProjectedYieldDetails,
} from '~/utils/projected-yield'
import { getLayeredVault } from '~/composables/useLayeredVaults'
import type { TrackedExecutionScope } from '~/composables/useSafeExecutionDetachment'

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { error } = useToast()
// Page uses SwapTokenSelector — opt into full wallet-token balance fetch while mounted.
useFullBalances()
const { planWithdrawOrRedeem, prepareTransactionPlan, executePreparedPlan, prefetchPluginData } = useEulerTx()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { account: cachedAccount } = useFreshAccount()
const { getVault, getSecuritizeVault: _getSecuritizeVault, getEscrowVault: _getEscrowVault, isMarketDataResolved } = useVaults()
const { isConnected, isSpyMode, effectiveAddress } = useEffectiveAddress()
const { runPreparedSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const {
  version: rewardsVersion,
  getSupplyRewardApy,
  getSupplyRewardCampaigns,
} = useRewardsApy()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const vaultAddress = route.params.vault as string
useOperationGuard([vaultAddress])
const subAccountIndex = Number(route.params.subAccount)
const subAccount = computed(() => {
  const addr = effectiveAddress.value
  if (!addr || isNaN(subAccountIndex)) return undefined
  return getSubAccountAddress(getAddress(addr), subAccountIndex)
})

const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isEstimatesLoading = ref(false)
const amount = ref('')
// `shallowRef` so Vue doesn't deep-unwrap the envelope's Account entity
// (the Account class has private brand members that drop on UnwrapRef).
const preparedPlan = shallowRef<TransactionPlanPrepared | null>(null)
const vault: Ref<EVault | SecuritizeCollateralVault | undefined> = ref()
const asset: Ref<VaultAsset | undefined> = ref()

// Check if vault is securitize (for things like supply/borrow which securitize doesn't have)
const isSecuritizeVaultType = computed(() => !!vault.value && isSecuritizeCollateralVault(vault.value))
const projectionEVault = computed(() => {
  const fallback = vault.value
  if (!fallback || isSecuritizeCollateralVault(fallback)) return undefined
  return getLayeredVault(fallback.address, fallback)
})
const yieldVault = computed(() => projectionEVault.value ?? vault.value)

const withdrawWarnings = computed(() => {
  if (!vault.value || isSecuritizeVaultType.value) return []
  return [
    getHookDisabledWarning(vault.value as EVault, effectiveWithdrawOp.value),
    getUtilisationWarning(vault.value as EVault, 'lend'),
  ]
})
// Share/asset balances come from the layer-aware account entity (usePlanAccount),
// not a direct on-chain balanceOf — so they reflect fresh + simulated state.
const { account: planAccount } = usePlanAccount()
const sharePosition = computed(() => {
  const acct = planAccount.value
  const sub = subAccount.value
  if (!acct || !sub || !vault.value?.address) return undefined
  try {
    const target = getAddress(vault.value.address)
    return acct.getSubAccount(getAddress(sub))?.positions.find(p => getAddress(p.vaultAddress) === target)
  }
  catch {
    return undefined
  }
})
const sharesBalance = computed(() => sharePosition.value?.shares ?? 0n)
const assetsBalance = computed(() => sharePosition.value?.assets ?? 0n)
const delta = ref(0n)
const estimateSupplyAPY = ref<number | null>(0)
const projectedYieldDetails = ref<ProjectedYieldDetails | null>(null)
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
  buildTxPlanForQuote: (quote, _provider, context) => buildSwapWithdrawPlanFromQuote(quote, context.account),
  getPlanAccount: () => cachedAccount.value,
  prefetchPluginData: (plan, account) => prefetchPluginData(plan, { account }),
})
const rewardApy = computed(() => {
  void rewardsVersion.value
  return getSupplyRewardApy(vault.value?.address || '')
})
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
  if (!isConnected.value && !isSpyMode.value) return false
  if (vault.value && !isSecuritizeVaultType.value && isOpDisabled(vault.value as EVault, effectiveWithdrawOp.value)) return true
  if (isOutputAssetBlocked.value || isOutputAssetRestricted.value) return true
  if (withdrawableAssets.value < amountFixed.value.value) return true
  if (isLoading.value || amountFixed.value.isZero() || amountFixed.value.isNegative()) return true
  if (estimatesError.value) return true
  if (needsSwap.value && !swapSelectedQuote.value && !isSwapQuoteLoading.value) return true
  return false
})
const reviewWithdrawDisabled = isSubmitDisabled
const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (vault.value && !isSecuritizeVaultType.value && isOpDisabled(vault.value as EVault, effectiveWithdrawOp.value)) return { message: 'Withdrawals are currently disabled for this vault', variant: 'warning' }
  if (isOutputAssetBlocked.value || isOutputAssetRestricted.value) return { message: 'Receiving this asset is not available in your region', variant: 'warning' }
  if (estimatesError.value) return { message: estimatesError.value, variant: 'error' }
  if (!amountFixed.value.isZero() && assetsBalance.value < amountFixed.value.value) return { message: 'Insufficient balance', variant: 'error' }
  if (!amountFixed.value.isZero() && withdrawableAssets.value < amountFixed.value.value) return { message: 'Not enough liquidity in vault', variant: 'error' }
  if (needsSwap.value && isSwapQuoteLoading.value && !amountFixed.value.isZero()) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (needsSwap.value && !swapSelectedQuote.value && !amountFixed.value.isZero()) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})
const supplyAPY = computed(() => {
  if (!yieldVault.value) return 0
  return getVaultTotalSupplyApy(yieldVault.value, enableIntrinsicApy.value, rewardApy.value)
})

const buildProjectedSupplyDetails = (rawApy: number): ProjectedYieldDetails | null => {
  const currentVault = projectionEVault.value
  if (!currentVault) return null
  const currentRaw = getVaultSupplyApy(currentVault)
  const currentWithIntrinsic = withVaultIntrinsicApy(currentRaw, currentVault, enableIntrinsicApy.value)
  const projectedWithIntrinsic = withVaultIntrinsicApy(rawApy, currentVault, enableIntrinsicApy.value)
  const before = getProjectedYieldState('supply-apy', {
    supplyUsd: 1,
    baseSupplyApy: currentRaw,
    intrinsicSupplyApy: currentWithIntrinsic - currentRaw,
    supplyRewardApy: rewardApy.value,
    borrowUsd: 0,
    baseBorrowApy: 0,
  })
  const after = getProjectedYieldState('supply-apy', {
    supplyUsd: 1,
    baseSupplyApy: rawApy,
    intrinsicSupplyApy: projectedWithIntrinsic - rawApy,
    supplyRewardApy: rewardApy.value,
    borrowUsd: 0,
    baseBorrowApy: 0,
  })
  if (!after) return null
  const campaigns = getSupplyRewardCampaigns(currentVault.address)
    .map(campaign => ({ campaign, vaultAddress: currentVault.address }))
  return {
    metric: 'supply-apy',
    before,
    after,
    rateLines: [{
      id: `supply:${currentVault.address.toLowerCase()}`,
      label: 'Lending APY',
      symbol: currentVault.asset.symbol,
      vaultAddress: currentVault.address,
      before: currentRaw,
      after: rawApy,
    }],
    rewards: mergeProjectedRewardCampaigns(campaigns, campaigns),
  }
}

// Reactive USD prices for display
const assetsBalanceUsd = ref(0)
const withdrawableAssetsUsd = ref(0)
const deltaUsd = ref(0)
const usdPriceGuard = createRaceGuard()

// Update USD prices when vault or amounts change
watchEffect(async () => {
  const gen = usdPriceGuard.next()
  void isMarketDataResolved.value
  if (!vault.value || isSecuritizeVaultType.value) {
    assetsBalanceUsd.value = 0
    withdrawableAssetsUsd.value = 0
    deltaUsd.value = 0
    return
  }
  const [nextAssetsBalanceUsd, nextWithdrawableAssetsUsd, nextDeltaUsd] = await Promise.all([
    getAssetUsdValueOrZero(assetsBalance.value, vault.value as EVault, 'off-chain'),
    getAssetUsdValueOrZero(withdrawableAssets.value, vault.value as EVault, 'off-chain'),
    getAssetUsdValueOrZero(delta.value, vault.value as EVault, 'off-chain'),
  ])
  if (usdPriceGuard.isStale(gen)) return
  assetsBalanceUsd.value = nextAssetsBalanceUsd
  withdrawableAssetsUsd.value = nextWithdrawableAssetsUsd
  deltaUsd.value = nextDeltaUsd
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

interface SwapWithdrawPlanSnapshot {
  asset: VaultAsset
  owner: Address
  shares: bigint
  assets: bigint
}

async function buildSwapWithdrawPlanFromQuote(quote: SwapQuote, account = cachedAccount.value, snapshot?: SwapWithdrawPlanSnapshot) {
  const inputAsset = snapshot?.asset ?? asset.value
  if (!inputAsset) throw new Error('Asset not loaded')
  return planWithdrawOrRedeem({
    vaultAddress: vaultAddress as Address,
    owner: snapshot?.owner ?? (subAccount.value ?? effectiveAddress.value!) as Address,
    // Swap quotes are fixed to an asset input amount; redeem-all can send more
    // assets than the quote was built for.
    isMax: false,
    shares: snapshot?.shares ?? sharesBalance.value,
    assets: snapshot?.assets ?? amountFixed.value.value,
    swapQuote: quote,
    account,
  })
}

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

  const userAddr = (effectiveAddress.value || zeroAddress) as Address
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
      vault.value = await _getSecuritizeVault(vaultAddress)
      estimateSupplyAPY.value = supplyAPY.value
      projectedYieldDetails.value = null
    }
    else {
      vault.value = await getVault(vaultAddress)
      const currentVault = projectionEVault.value ?? (vault.value as EVault)
      const rawApy = getVaultSupplyApy(currentVault)
      estimateSupplyAPY.value = withVaultIntrinsicApy(rawApy, currentVault, enableIntrinsicApy.value) + rewardApy.value
      projectedYieldDetails.value = buildProjectedSupplyDetails(rawApy)
    }

    asset.value = vault.value?.asset

    // Share/asset balances are reactive over the account entity; just seed delta.
    updateBalance()
  }
  catch (e) {
    showError('Unable to load Vault')
    console.warn(e)
  }
  finally {
    isLoading.value = false
  }
}
// `assetsBalance`/`sharesBalance` are now reactive computeds over the account
// entity, so this only refreshes the `delta` baseline used by the summary.
const updateBalance = () => {
  delta.value = (!isConnected.value && !isSpyMode.value) ? 0n : assetsBalance.value
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

      preparedPlan.value = null
      try {
        const rawPlan = await planWithdrawOrRedeem({
          vaultAddress: vaultAddress as Address,
          owner: (subAccount.value ?? effectiveAddress.value!) as Address,
          isMax,
          shares: sharesBalance.value,
          assets: amountFixed.value.value,
          swapQuote: needsSwap.value ? (swapSelectedQuote.value ?? undefined) : undefined,
          // Pass the race-replaced cached Account so planWithdraw/planRedeem
          // skip the per-click freshPlanContext.fetchAccount round-trip.
          account: cachedAccount.value,
        })
        // Run plugins + approval resolution ONCE so simulate/execute (and the
        // modal's display steps) all see the same enriched plan. Without this
        // the SDK would re-run plugins inside simulate, the modal, and execute.
        preparedPlan.value = await prepareTransactionPlan(rawPlan, { account: cachedAccount.value })
      }
      catch (e) {
        console.warn('[lend/withdraw] failed to build/prepare plan', e)
        simulationError.value = await getTxErrorMessage(e)
        return
      }

      // `preparedPlan.value` is non-null here — the try block either set it or returned.
      const ok = await runPreparedSimulation(preparedPlan.value!)
      if (!ok) return

      const reviewType = needsSwap.value ? 'swap-withdraw' as const : 'withdraw' as const
      modal.open(OperationReviewModal, {
        props: {
          type: reviewType,
          asset: asset.value,
          amount: amount.value,
          prepared: preparedPlan.value!,
          quoteFetchedAt: needsSwap.value ? swapEffectiveQuoteFetchedAt.value : null,
          swapToAsset: needsSwap.value ? selectedOutputAsset.value : undefined,
          swapToAmount: needsSwap.value ? swapEstimatedOutput.value : undefined,
          swapMode: needsSwap.value ? SwapperMode.EXACT_IN : undefined,
          submittingLabel: 'Submitting...',
          onConfirm: async (execution) => {
            await send(execution)
          },
        },
      })
    })
  }
  finally {
    isPreparing.value = false
  }
}
const send = async (execution: TrackedExecutionScope) => {
  try {
    isSubmitting.value = true
    if (!asset.value?.address) {
      return
    }

    if (!preparedPlan.value) return
    await executePreparedPlan(preparedPlan.value)

    // share/asset balances are reactive over the account entity, which refreshes
    // after the tx; evict cached wallet token queries for the swap-output display.
    await invalidateSdkQueries(['queryTokenBalances', 'queryBalanceOf', 'queryNativeBalance'])
    updateBalance()
    amount.value = ''
    preparedPlan.value = null
    resetSwapQuoteState()

    // Success signal for a detached Safe completion toast; a proposal that
    // confirmed after its modal was closed must not redirect mid-flow.
    execution.markSucceeded()
    if (!execution.suppressPostTxUi()) {
      modal.close()
      setTimeout(() => {
        router.replace({ path: '/portfolio/saving', query: { network: route.query.network } })
      }, 400)
    }
  }
  catch (e) {
    error('Transaction failed')
    console.warn(e)
  }
  finally {
    isSubmitting.value = false
  }
}
// Add this withdraw to the transaction batch. The plan is captured against the
// current batch end-state, so withdrawing on top of a simulated deposit works
// even though the on-chain share balance shown by the form is still zero. Direct
// (non-swap), non-max withdraw by asset amount.
const isCowSwapSelected = computed(() => isCowProviderOrQuote(swapSelectedProvider.value, swapSelectedQuote.value))
const canAddToBatch = computed(() => {
  if (isOutputAssetBlocked.value || isOutputAssetRestricted.value) return false
  if (vault.value && !isSecuritizeVaultType.value && isOpDisabled(vault.value as EVault, effectiveWithdrawOp.value)) return false
  if (!(+amount.value)) return false
  if (needsSwap.value) return !!swapSelectedQuote.value && !isCowSwapSelected.value
  return true
})

const addToBatch = async () => {
  if (!canAddToBatch.value || !asset.value?.address) return
  await guardWithPriceImpact(async () => {
    if (!asset.value?.address) return
    if (needsSwap.value) {
      const quote = swapEffectiveQuote.value
      if (!quote) return
      const ownerAddr = (subAccount.value ?? effectiveAddress.value) as Address | undefined
      if (!ownerAddr) return
      const snap = {
        asset: asset.value,
        owner: ownerAddr,
        shares: sharesBalance.value,
        assets: amountFixed.value.value,
      }
      const amountLabel = amount.value
      const outputAsset = selectedOutputAsset.value
      const outputAmount = swapEstimatedOutput.value
      await addBatchEntry({
        label: `Withdraw-swap ${amountLabel} ${asset.value.symbol} → ${outputAsset?.symbol ?? ''}`,
        buildPlan: account => buildSwapWithdrawPlanFromQuote(quote, account, snap),
        subAccount: ownerAddr,
        review: { type: 'swap-withdraw', asset: asset.value, amount: amountLabel, swapToAsset: outputAsset, swapToAmount: outputAmount, quoteFetchedAt: swapEffectiveQuoteFetchedAt.value },
      })
    }
    else {
      const assets = valueToNano(amount.value, asset.value.decimals)
      const ownerAddr = (subAccount.value ?? effectiveAddress.value) as Address | undefined
      if (!ownerAddr) return
      // A max withdraw must redeem the full share balance (redeem(full_balance))
      // rather than withdraw(assets): a fixed asset amount leaves share-price
      // rounding dust and can under-withdraw once interest accrues by execution.
      const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)
      const shares = sharesBalance.value
      await addBatchEntry({
        label: `Withdraw ${amount.value} ${asset.value.symbol}`,
        buildPlan: account => planWithdrawOrRedeem({ vaultAddress: vaultAddress as Address, owner: ownerAddr, isMax, shares, assets, account }),
        subAccount: ownerAddr,
        review: { type: 'withdraw', asset: asset.value, amount: amount.value },
      })
    }
    amount.value = ''
    redirectAfterAdd('/portfolio/saving', { subAccount: subAccount.value ?? effectiveAddress.value, vault: vaultAddress })
  })
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
  if (!projectionEVault.value || isSecuritizeVaultType.value) {
    isEstimatesLoading.value = false
    return
  }
  const gen = estimatesGuard.next()
  try {
    const v = projectionEVault.value
    const amountNano = valueToNano(amount.value, v.shares.decimals)
    const projected = await getProjectedRates(
      v.address,
      v.totalCash,
      v.totalBorrowed,
      -amountNano,
      0n,
    )
    if (estimatesGuard.isStale(gen)) return
    if (!projected) {
      estimateSupplyAPY.value = null
      projectedYieldDetails.value = null
      return
    }
    const rawApy = nanoToValue(projected.supplyAPY, 25)
    const details = buildProjectedSupplyDetails(rawApy)
    estimateSupplyAPY.value = details?.after.total ?? null
    projectedYieldDetails.value = details
  }
  catch (e) {
    if (estimatesGuard.isStale(gen)) return
    logWarn('lend-withdraw/asyncEstimates', e)
    estimateSupplyAPY.value = null
    projectedYieldDetails.value = null
  }
  finally {
    if (!estimatesGuard.isStale(gen)) {
      isEstimatesLoading.value = false
    }
  }
}, 500)

const queueAsyncEstimates = () => {
  estimatesGuard.next()
  estimateSupplyAPY.value = null
  projectedYieldDetails.value = null
  if (!vault.value) {
    isEstimatesLoading.value = false
    return
  }
  if (isSecuritizeVaultType.value) {
    estimateSupplyAPY.value = supplyAPY.value
    isEstimatesLoading.value = false
    return
  }
  if (!(+amount.value > 0)) {
    const rawApy = getVaultSupplyApy(projectionEVault.value)
    estimateSupplyAPY.value = supplyAPY.value
    projectedYieldDetails.value = buildProjectedSupplyDetails(rawApy)
    isEstimatesLoading.value = false
    return
  }
  isEstimatesLoading.value = true
  updateAsyncEstimates()
}

load()

// assetsBalance/sharesBalance are reactive over the account entity (incl. the
// active batch layer); just keep the delta baseline in sync.
watch([isConnected, effectiveAddress, assetsBalance], () => {
  if (vault.value) updateBalance()
})
watch(amount, async () => {
  updateSyncEstimates()
  queueAsyncEstimates()
  if (needsSwap.value) {
    resetSwapQuoteState()
    requestSwapQuote()
  }
})

watch([
  rewardsVersion,
  enableIntrinsicApy,
  () => projectionEVault.value?.totalCash,
  () => projectionEVault.value?.totalBorrowed,
], () => {
  queueAsyncEstimates()
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
              :vault="(vault as EVault)"
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

              <UiAlert
                v-if="swapQuoteError"
                title="Swap quote"
                variant="warning"
                :description="swapQuoteError"
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
              v-if="isOutputAssetBlocked || isOutputAssetRestricted"
              title="Asset restricted"
              description="Receiving this asset is not available in your region. Pick a different token."
              variant="warning"
              size="compact"
            />

            <UiAlert
              v-show="estimatesError"
              title="Error"
              variant="error"
              :description="estimatesError"
              size="compact"
            />
            <UiAlert
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
            <ProjectedYieldSummaryRow
              label="Supply APY"
              :before="supplyAPY"
              :after="estimateSupplyAPY"
              :details="projectedYieldDetails"
            />
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
              :can-add-to-batch="canAddToBatch"
              @add-to-batch="addToBatch"
            >
              Review Withdraw
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
