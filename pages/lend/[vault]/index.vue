<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getAddress, formatUnits, type Address, zeroAddress } from 'viem'
import { isNativeCurrencyAddress, isNativeOfWrapped, resolveWrappedNativeAddress, resolveWrappedNativeAsset } from '~/utils/native-currency'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal, VaultSupplyApyModal, VaultUnverifiedDisclaimerModal, SwapTokenSelector, SlippageSettingsModal } from '#components'
import { useToast } from '~/components/ui/composables/useToast'
import { computeAPYs, getCurrentLiquidationLTV, type SecuritizeVault, type Vault, type VaultAsset } from '~/entities/vault'
import { isSecuritizeVault } from '~/entities/vault/factory'
import { getUtilisationWarning, getSupplyCapWarning } from '~/composables/useVaultWarnings'
import { collectPythFeedIds } from '~/entities/oracle'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import { fetchBackendPrice } from '~/services/pricing/backendClient'
import type { TxPlan } from '~/entities/txPlan'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'
import { type SwapApiQuote, SwapperMode } from '~/entities/swap'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import VaultFormInfoBlock from '~/components/entities/vault/form/VaultFormInfoBlock.vue'
import VaultFormSubmit from '~/components/entities/vault/form/VaultFormSubmit.vue'
import SecuritizeVaultOverview from '~/components/entities/vault/overview/SecuritizeVaultOverview.vue'
import { formatNumber, compactNumber, formatSmartAmount } from '~/utils/string-utils'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'

// Type definitions for vault display
type VaultType = 'evk' | 'securitize'

interface VaultFeatures {
  hasInterestRate: boolean
  hasCollateralLTVs: boolean
  hasPriceInfo: boolean
  hasVerifiedStatus: boolean
  hasPoints: boolean
  hasOverview: boolean
}

const VAULT_FEATURES: Record<VaultType, VaultFeatures> = {
  evk: {
    hasInterestRate: true,
    hasCollateralLTVs: true,
    hasPriceInfo: true,
    hasVerifiedStatus: true,
    hasPoints: true,
    hasOverview: true,
  },
  securitize: {
    hasInterestRate: false,
    hasCollateralLTVs: false,
    hasPriceInfo: false,
    hasVerifiedStatus: false,
    hasPoints: false,
    hasOverview: true,
  },
}

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { error } = useToast()
const reviewSupplyLabel = 'Review Supply'
const { buildSupplyPlan, buildSwapAndSupplyPlan, executeTxPlan } = useEulerOperations()
const { getVault, getSecuritizeVault, getEscrowVault, updateVault, isEscrowLoadedOnce } = useVaults()
const { get: registryGet, getVault: _registryGetVault, isKnownEscrowAddress } = useVaultRegistry()
const { isConnected, address } = useAccount()
const { chainId } = useEulerAddresses()
const { fetchSingleBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTxPlanSimulation()
const vaultAddress = route.params.vault as string
useOperationGuard([vaultAddress])
const { name } = useEulerProductOfVault(vaultAddress)
const { getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()

// State
const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isEstimatesLoading = ref(false)
const amount = ref('')
const plan = ref<TxPlan | null>(null)
const estimateSupplyAPY = ref(0n)
const monthlyEarnings = ref(0)
const monthlyEarningsUsd = ref(0)

// Swap & deposit state
const selectedAsset = ref<VaultAsset | undefined>()
const selectedAssetBalance = ref(0n)
const swapAssetUsdPrice = ref<number | undefined>()
const isUnknownSwapToken = ref(false)
const needsSwap = computed(() => {
  if (!selectedAsset.value || !asset.value) return false
  try {
    if (isNativeOfWrapped(selectedAsset.value.address, asset.value.address, chainId.value!)) return false
    return getAddress(selectedAsset.value.address) !== getAddress(asset.value.address)
  }
  catch {
    return false
  }
})
const isNativeWrap = computed(() => {
  if (!selectedAsset.value || !asset.value) return false
  return isNativeOfWrapped(selectedAsset.value.address, asset.value.address, chainId.value!)
})
const { slippage: swapSlippage } = useSlippage({
  fromSymbol: () => selectedAsset.value?.symbol,
  toSymbol: () => evkVault.value?.asset.symbol || securitizeVault.value?.asset.symbol,
})
const {
  sortedQuoteCards: swapQuoteCardsSorted,
  selectedProvider: swapSelectedProvider,
  selectedQuote: swapSelectedQuote,
  effectiveQuote: swapEffectiveQuote,
  providersCount: _swapProvidersCount,
  isLoading: isSwapQuoteLoading,
  quoteError: swapQuoteError,
  statusLabel: swapQuotesStatusLabel,
  getQuoteDiffPct: getSwapQuoteDiffPct,
  reset: resetSwapQuoteState,
  requestQuotes: requestSwapQuotes,
  selectProvider: selectSwapQuote,
} = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max' })

// Vault data - only one will be populated based on type
const evkVault: Ref<Vault | undefined> = ref(undefined)
const securitizeVault: Ref<SecuritizeVault | undefined> = ref(undefined)
const balance = ref(0n)

// Check if vault uses Pyth oracles (requires fresh prices)
const hasPythOracles = (v: Vault | undefined): boolean => {
  if (!v) return false
  const feeds = collectPythFeedIds(v.oracleDetailedInfo)
  return feeds.length > 0
}

// Check if vault has price failure (0n is valid - very small price)
const hasPriceFailure = (v: Vault | undefined): boolean => {
  if (!v) return false
  return (
    v.liabilityPriceInfo?.queryFailure
    || v.liabilityPriceInfo?.amountOutMid === undefined
    || v.liabilityPriceInfo?.amountOutMid === null
  )
}

// Check if vault needs refresh (Pyth detected OR price failure)
const needsRefresh = (v: Vault | undefined): boolean => {
  return hasPythOracles(v) || hasPriceFailure(v)
}

// Non-blocking IIFE to avoid Suspense + pageTransition crash on direct navigation
;(async () => {
  const isSecuritize = await isSecuritizeVault(vaultAddress)

  if (isSecuritize) {
    securitizeVault.value = await getSecuritizeVault(vaultAddress)
  }
  else {
    try {
      const normalizedAddress = getAddress(vaultAddress)

      // Fast path: vault already in registry
      const registryEntry = registryGet(normalizedAddress)
      if (registryEntry?.type === 'evk') {
        evkVault.value = registryEntry.vault as Vault
      }
      // Escrow vaults haven't loaded yet - wait for them
      else if (!isEscrowLoadedOnce.value) {
        await until(isEscrowLoadedOnce).toBe(true)
        const entryAfterLoad = registryGet(normalizedAddress)
        if (entryAfterLoad?.type === 'evk') {
          evkVault.value = entryAfterLoad.vault as Vault
        }
        else if (isKnownEscrowAddress(normalizedAddress)) {
          evkVault.value = await getEscrowVault(vaultAddress) as Vault
        }
        else {
          evkVault.value = await getVault(vaultAddress)
        }
      }
      // Escrow vaults loaded - check if known escrow address
      else if (isKnownEscrowAddress(normalizedAddress)) {
        evkVault.value = await getEscrowVault(vaultAddress) as Vault
      }
      // Regular vault
      else {
        evkVault.value = await getVault(vaultAddress)
      }

      // Load any collateral vaults that aren't already in registry
      if (evkVault.value) {
        const { has: registryHas } = useVaultRegistry()

        const collateralAddresses = evkVault.value.collateralLTVs
          .filter(ltv => getCurrentLiquidationLTV(ltv) > 0n)
          .map(ltv => ltv.collateral)

        // Check and load missing collaterals in parallel
        await Promise.all(
          collateralAddresses.map(async (collateralAddr) => {
            // Skip if already loaded in registry
            if (registryHas(collateralAddr)) return

            try {
              // Try regular vault first, then securitize
              await getVault(collateralAddr)
            }
            catch {
              // If regular vault fails, try securitize
              try {
                await getSecuritizeVault(collateralAddr)
              }
              catch {
                // Ignore - collateral vault might not be accessible
              }
            }
          }),
        )
      }
    }
    catch (e) {
      // If EVK vault load fails, try as securitize vault
      console.warn('[lend] EVK vault load failed, trying securitize:', e)
      securitizeVault.value = await getSecuritizeVault(vaultAddress)
    }
  }

  // Refresh EVK vault if it uses Pyth oracles or has price failure
  // Pyth prices are only valid for ~2 minutes, so always refresh when Pyth is detected
  if (evkVault.value && needsRefresh(evkVault.value)) {
    const refreshedVault = await updateVault(vaultAddress)
    if (!('type' in refreshedVault && refreshedVault.type === 'securitize')) {
      evkVault.value = refreshedVault as Vault
    }
  }

  // @ts-expect-error load is declared below but always initialized by the time this async IIFE reaches here
  load()
})()

const features = computed(() => VAULT_FEATURES[vaultType.value])

// Determine vault type based on which vault was loaded
const vaultType = computed<VaultType>(() => securitizeVault.value ? 'securitize' : 'evk')

// Unified accessors - these provide a common interface regardless of vault type
const _vaultName = computed(() => evkVault.value?.name || securitizeVault.value?.name || '')
const asset = computed(() => evkVault.value?.asset || securitizeVault.value?.asset)

// For components that need the EVK Vault type (VaultLabelsAndAssets, VaultPoints, etc.)
const vault = computed(() => evkVault.value)

const fetchBalance = async () => {
  if (!asset.value?.address) {
    balance.value = 0n
    return
  }
  balance.value = await fetchSingleBalance(asset.value.address)
}
const fetchSelectedAssetBalance = async () => {
  if (!selectedAsset.value?.address) {
    selectedAssetBalance.value = 0n
    return
  }
  selectedAssetBalance.value = await fetchSingleBalance(selectedAsset.value.address)
}
const activeBalance = computed(() => (needsSwap.value || isNativeWrap.value) ? selectedAssetBalance.value : balance.value)
const activeAsset = computed(() => (needsSwap.value || isNativeWrap.value) ? selectedAsset.value : asset.value)
const errorText = computed(() => {
  if (activeBalance.value < valueToNano(amount.value, activeAsset.value?.decimals)) {
    return 'Not enough balance'
  }
  return null
})
const isSupplyCapReached = computed(() => evkVault.value ? getIsSupplyCapReached(evkVault.value) : false)
const assets = computed(() => [asset.value!])
const isSubmitDisabled = computed(() => {
  if (!isConnected.value) return false
  if (activeBalance.value < valueToNano(amount.value, activeAsset.value?.decimals)) return true
  if (isLoading.value || !(+amount.value)) return true
  if (needsSwap.value && !swapSelectedQuote.value) return true
  if (isSupplyCapReached.value) return true
  return false
})
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vaultAddress))
const isSwapRestricted = computed(() => needsSwap.value && isVaultRestrictedByCountry(vaultAddress))
const reviewSupplyDisabled = computed(() => isGeoBlocked.value || isSwapRestricted.value || isSubmitDisabled.value)
const totalRewardsAPY = computed(() => getSupplyRewardApy(vaultAddress))
const hasRewards = computed(() => hasSupplyRewards(vaultAddress))
const intrinsicApy = computed(() => getIntrinsicApy(asset.value?.address))

const baseSupplyApy = computed(() => {
  if (!features.value.hasInterestRate) return 0
  if (!evkVault.value) return 0
  return nanoToValue(evkVault.value.interestRateInfo.supplyAPY, 25)
})
const supplyApyWithIntrinsic = computed(() => baseSupplyApy.value + intrinsicApy.value)
const supplyAPYDisplay = computed(() => {
  if (!evkVault.value && !securitizeVault.value) return '0.00'
  return formatNumber(supplyApyWithIntrinsic.value + totalRewardsAPY.value)
})
const estimateSupplyAPYDisplay = computed(() => {
  return formatNumber(nanoToValue(estimateSupplyAPY.value, 25))
})

// Vault warnings for lend context
const lendWarnings = computed(() => {
  if (!evkVault.value) return []
  return [
    getUtilisationWarning(evkVault.value, 'lend'),
    getSupplyCapWarning(evkVault.value),
  ]
})

// Check if vault data is loaded
const isVaultLoaded = computed(() => !!evkVault.value || !!securitizeVault.value)

// Check if vault is verified - both EVK and securitize vaults have verified field
const isVaultVerified = computed(() => {
  return evkVault.value?.verified ?? securitizeVault.value?.verified ?? true
})

const load = async () => {
  isLoading.value = true
  try {
    // Fetch fresh underlying asset balance for this specific vault
    await fetchBalance()

    if (features.value.hasInterestRate && evkVault.value) {
      estimateSupplyAPY.value = evkVault.value.interestRateInfo.supplyAPY + valueToNano(totalRewardsAPY.value + intrinsicApy.value, 25)
    }
    else {
      // For vaults without interest rate info, just use rewards
      estimateSupplyAPY.value = valueToNano(totalRewardsAPY.value + intrinsicApy.value, 25)
    }

    // Show warning modal for any unverified vault
    if (!isVaultVerified.value) {
      modal.open(VaultUnverifiedDisclaimerModal, {
        isNotClosable: true,
        props: {
          cancelAction: () => {
            router.replace('/')
          },
        },
      })
    }
  }
  catch (e) {
    showError('Unable to load Vault')
    console.warn(e)
  }
  finally {
    isLoading.value = false
  }
}

const buildSwapSupplyPlanFromQuote = async (quote: SwapApiQuote, options: { includePermit2Call?: boolean } = {}): Promise<TxPlan> => {
  if (!selectedAsset.value) {
    throw new Error('No selected asset')
  }
  const isNative = isNativeCurrencyAddress(selectedAsset.value.address)
  const inputAmount = valueToNano(amount.value || '0', selectedAsset.value.decimals)
  const wrappedAddress = isNative ? resolveWrappedNativeAddress(chainId.value!) : null
  if (isNative && !wrappedAddress) {
    throw new Error('Wrapped native token not found')
  }
  return buildSwapAndSupplyPlan({
    inputTokenAddress: (wrappedAddress || selectedAsset.value.address) as Address,
    inputAmount,
    quote,
    includePermit2Call: options.includePermit2Call,
    wrappedNativeInfo: isNative && wrappedAddress
      ? { wrappedTokenAddress: wrappedAddress, nativeAmount: inputAmount }
      : undefined,
  })
}

const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value || isGeoBlocked.value || isSwapRestricted.value) return
  isPreparing.value = true
  try {
    await guardWithPriceImpact(async () => {
      if (!asset.value?.address) {
        return
      }

      try {
        if (needsSwap.value && swapEffectiveQuote.value) {
          plan.value = await buildSwapSupplyPlanFromQuote(swapEffectiveQuote.value, { includePermit2Call: false })
        }
        else {
          const supplyAmount = valueToNano(amount.value || '0', asset.value.decimals)
          const wrappedAddr = isNativeWrap.value ? resolveWrappedNativeAddress(chainId.value!) : null
          plan.value = await buildSupplyPlan(
            vaultAddress,
            asset.value.address,
            supplyAmount,
            undefined,
            {
              includePermit2Call: false,
              wrappedNativeInfo: isNativeWrap.value && wrappedAddr
                ? { wrappedTokenAddress: wrappedAddr, nativeAmount: supplyAmount }
                : undefined,
            },
          )
        }
      }
      catch (e) {
        console.warn('[OperationReviewModal] failed to build plan', e)
        plan.value = null
      }

      if (plan.value) {
        const ok = await runSimulation(plan.value)
        if (!ok) {
          return
        }
      }

      const isNativeSwap = needsSwap.value && selectedAsset.value && isNativeCurrencyAddress(selectedAsset.value.address)
      const reviewAsset = isNativeSwap
        ? (resolveWrappedNativeAsset(chainId.value!) || selectedAsset.value!)
        : needsSwap.value && selectedAsset.value ? selectedAsset.value : asset.value
      const reviewType = needsSwap.value ? 'swap-supply' as const : 'supply' as const
      modal.open(OperationReviewModal, {
        props: {
          type: reviewType,
          asset: reviewAsset,
          amount: amount.value,
          plan: plan.value || undefined,
          swapToAsset: needsSwap.value ? asset.value : undefined,
          swapToAmount: needsSwap.value ? swapEstimatedOutput.value : undefined,
          onConfirm: () => {
            setTimeout(() => {
              send()
            }, 400)
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

    let txPlan: TxPlan
    if (needsSwap.value && swapSelectedQuote.value) {
      txPlan = await buildSwapSupplyPlanFromQuote(swapSelectedQuote.value)
    }
    else if (needsSwap.value && swapEffectiveQuote.value) {
      txPlan = await buildSwapSupplyPlanFromQuote(swapEffectiveQuote.value)
    }
    else {
      const supplyAmount = valueToNano(amount.value || '0', asset.value.decimals)
      const wrappedAddr = isNativeWrap.value ? resolveWrappedNativeAddress(chainId.value!) : null
      txPlan = await buildSupplyPlan(vaultAddress, asset.value.address, supplyAmount, undefined, {
        includePermit2Call: true,
        wrappedNativeInfo: isNativeWrap.value && wrappedAddr
          ? { wrappedTokenAddress: wrappedAddr, nativeAmount: supplyAmount }
          : undefined,
      })
    }
    await executeTxPlan(txPlan)

    modal.close()
    await updateEstimates()
    setTimeout(() => {
      router.replace('/portfolio/saving')
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

const updateEstimates = useDebounceFn(async () => {
  if (!isVaultLoaded.value) {
    return
  }
  try {
    if (features.value.hasInterestRate && evkVault.value) {
      await updateVault(evkVault.value.address)
      if (!asset.value?.address) {
        return
      }
      const [, supplyAPY] = await computeAPYs(
        evkVault.value.interestRateInfo.borrowSPY,
        evkVault.value.interestRateInfo.cash + valueToNano(amount.value, evkVault.value.decimals),
        evkVault.value.interestRateInfo.borrows,
        evkVault.value.interestFee,
      )
      estimateSupplyAPY.value = supplyAPY + valueToNano(totalRewardsAPY.value + intrinsicApy.value, 25)
      monthlyEarnings.value = !amount.value
        ? 0
        : (+(amount.value || 0) * nanoToValue(estimateSupplyAPY.value, 27)) / 12
    }
    else {
      // For vaults without interest rate computation
      estimateSupplyAPY.value = valueToNano(totalRewardsAPY.value + intrinsicApy.value, 25)
      monthlyEarnings.value = !amount.value
        ? 0
        : (+(amount.value || 0) * nanoToValue(estimateSupplyAPY.value, 27)) / 12
    }
  }
  catch (e) {
    console.warn(e)
  }
  finally {
    isEstimatesLoading.value = false
  }
}, 500)

const onSupplyInfoIconClick = () => {
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: baseSupplyApy.value,
      intrinsicAPY: intrinsicApy.value,
      intrinsicApyInfo: getIntrinsicApyInfo(asset.value?.address),
      campaigns: getSupplyRewardCampaigns(vaultAddress),
    },
  })
}

// Swap quote helpers
const swapEstimatedOutput = computed(() => {
  if (!swapEffectiveQuote.value || !asset.value) return ''
  const amountOut = BigInt(swapEffectiveQuote.value.amountOut || 0)
  if (amountOut <= 0n) return ''
  return formatUnits(amountOut, Number(asset.value.decimals))
})

const swapInputDisplay = computed(() => {
  if (!swapEffectiveQuote.value || !selectedAsset.value) return ''
  const amountIn = BigInt(swapEffectiveQuote.value.amountIn || 0)
  if (amountIn <= 0n) return ''
  return `${formatSmartAmount(formatUnits(amountIn, Number(selectedAsset.value.decimals)))} ${selectedAsset.value.symbol}`
})

const swapOutputDisplay = computed(() => {
  if (!swapEffectiveQuote.value || !asset.value) return ''
  const amountOut = BigInt(swapEffectiveQuote.value.amountOut || 0)
  if (amountOut <= 0n) return ''
  return `${formatSmartAmount(formatUnits(amountOut, Number(asset.value.decimals)))} ${asset.value.symbol}`
})

const swapRoutedVia = computed(() => {
  if (!swapEffectiveQuote.value?.route?.length) return null
  return swapEffectiveQuote.value.route.map((r: { providerName: string }) => r.providerName).join(', ')
})

const { priceImpact: swapPriceImpact } = useSwapPriceImpact({
  quote: swapEffectiveQuote,
  toVault: evkVault,
})

const { guardWithPriceImpact } = usePriceImpactGate({
  directPriceImpact: swapPriceImpact,
})

const swapRouteItems = computed(() => {
  if (!asset.value) return []
  return buildSwapRouteItems({
    quoteCards: swapQuoteCardsSorted.value,
    getQuoteDiffPct: getSwapQuoteDiffPct,
    decimals: Number(asset.value.decimals),
    symbol: asset.value.symbol,
    formatAmount: formatSmartAmount,
  })
})

const requestSwapQuote = useDebounceFn(async () => {
  swapQuoteError.value = null

  if (!selectedAsset.value || !asset.value || !needsSwap.value || !amount.value) {
    resetSwapQuoteState()
    return
  }

  const inputAmountNano = valueToNano(amount.value || '0', selectedAsset.value.decimals)
  if (inputAmountNano <= 0n) {
    resetSwapQuoteState()
    return
  }

  const userAddr = (address.value || zeroAddress) as Address
  const swapTokenIn = isNativeCurrencyAddress(selectedAsset.value.address)
    ? resolveWrappedNativeAddress(chainId.value!) || selectedAsset.value.address
    : selectedAsset.value.address
  await requestSwapQuotes({
    tokenIn: swapTokenIn as Address,
    tokenOut: asset.value.address as Address,
    accountIn: zeroAddress as Address,
    accountOut: userAddr,
    amount: inputAmountNano,
    vaultIn: zeroAddress as Address,
    receiver: vaultAddress as Address,
    unusedInputReceiver: userAddr,
    slippage: swapSlippage.value,
    swapperMode: SwapperMode.EXACT_IN,
    isRepay: false,
    targetDebt: 0n,
    currentDebt: 0n,
  }, {
    logContext: {
      tokenIn: selectedAsset.value.address,
      tokenOut: asset.value.address,
      amount: amount.value,
      slippage: swapSlippage.value,
    },
  })
}, 500)

const onSelectSwapAsset = (newAsset: VaultAsset, meta?: { isUnknownToken?: boolean }) => {
  selectedAsset.value = newAsset
  isUnknownSwapToken.value = meta?.isUnknownToken ?? false
  amount.value = ''
  clearSimulationError()
  resetSwapQuoteState()
}

const openSwapTokenSelector = () => {
  modal.open(SwapTokenSelector, {
    props: {
      currentAssetAddress: selectedAsset.value?.address || asset.value?.address,
      onSelect: onSelectSwapAsset,
      allowNativeCurrency: true,
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

// Fetch selected asset balance and USD price when it changes
watch(selectedAsset, async () => {
  fetchSelectedAssetBalance()
  if (needsSwap.value && amount.value) {
    resetSwapQuoteState()
    requestSwapQuote()
  }
  if (selectedAsset.value?.address && (needsSwap.value || isNativeWrap.value)) {
    const priceAddr = isNativeCurrencyAddress(selectedAsset.value.address)
      ? resolveWrappedNativeAddress(chainId.value!) || selectedAsset.value.address
      : selectedAsset.value.address
    const priceData = await fetchBackendPrice(priceAddr as Address)
    swapAssetUsdPrice.value = priceData?.price
  }
  else {
    swapAssetUsdPrice.value = undefined
  }
})

// Re-request quote when amount changes and swap is needed
watch(amount, () => {
  if (needsSwap.value) {
    resetSwapQuoteState()
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

// Update USD value when monthlyEarnings or vault changes
watchEffect(async () => {
  if (!vault.value || !monthlyEarnings.value) {
    monthlyEarningsUsd.value = 0
    return
  }
  monthlyEarningsUsd.value = await getAssetUsdValueOrZero(monthlyEarnings.value, vault.value, 'off-chain')
})

watch(amount, async () => {
  clearSimulationError()
  if (!isVaultLoaded.value) {
    return
  }
  if (!isEstimatesLoading.value) {
    isEstimatesLoading.value = true
  }
  updateEstimates()
})

watch(address, () => {
  fetchBalance()
  fetchSelectedAssetBalance()
})
</script>

<template>
  <div>
    <div
      v-if="!isVaultLoaded"
      class="flex justify-center items-center min-h-[50dvh]"
    >
      <UiLoader />
    </div>
    <template v-else>
      <BaseBackButton class="laptop:!hidden mb-16" />

      <!-- Vault header -->
      <VaultLabelsAndAssets
        v-if="asset && (vault || securitizeVault)"
        class="mb-24"
        :vault="(vault || securitizeVault)!"
        :assets="assets"
        size="large"
      />

      <div class="flex gap-32">
        <div class="hidden laptop:!block laptop:flex-[55] min-w-0">
          <!-- EVK Vault Overview -->
          <VaultOverview
            v-if="features.hasOverview && vault && vaultType === 'evk'"
            :vault="vault"
            desktop-overview
            @vault-click="(address: string) => router.push({ path: `/borrow/${address}/${vault!.address}`, query: { network: route.query.network } })"
          />
          <!-- Securitize Vault Overview -->
          <SecuritizeVaultOverview
            v-if="features.hasOverview && securitizeVault && vaultType === 'securitize'"
            :vault="securitizeVault"
            desktop-overview
          />
        </div>
        <div class="flex flex-col gap-16 w-full laptop:flex-[45] laptop:sticky laptop:top-[88px] laptop:self-start">
          <VaultForm
            class="w-full"
            @submit.prevent="submit"
          >
            <div
              v-if="isVaultLoaded && asset"
              class="flex items-center justify-between"
            >
              <p class="text-h3 text-content-tertiary flex items-center gap-4">
                Supply APY
                <SvgIcon
                  class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  @click="onSupplyInfoIconClick"
                />
              </p>

              <p class="flex items-center gap-4 text-h3">
                <VaultPoints
                  v-if="features.hasPoints && vault"
                  class="mr-4"
                  :vault="vault"
                />
                <SvgIcon
                  v-if="hasRewards"
                  class="!w-24 !h-24 text-accent-600 cursor-pointer"
                  name="sparks"
                  @click="onSupplyInfoIconClick"
                />
                <span>
                  {{ supplyAPYDisplay }}%
                </span>
              </p>
            </div>

            <AssetInput
              v-if="asset"
              v-model="amount"
              label="Supply amount"
              :desc="name"
              :asset="(needsSwap || isNativeWrap) && selectedAsset ? selectedAsset : asset"
              :vault="(needsSwap || isNativeWrap) ? undefined : (vault || securitizeVault)"
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
                  :asset="{ address: selectedAsset?.address || asset?.address || '', symbol: selectedAsset?.symbol || asset?.symbol || '' }"
                  size="20"
                />
                {{ selectedAsset?.symbol || asset?.symbol }}
                <SvgIcon
                  class="text-content-tertiary !w-16 !h-16"
                  name="arrow-down"
                />
              </button>
            </div>

            <!-- Swap info block -->
            <template v-if="needsSwap && asset">
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
                v-if="swapEstimatedOutput"
                :loading="isSwapQuoteLoading"
                variant="card"
              >
                <SwapDetailsSummary
                  :input-display="swapInputDisplay"
                  :output-display="swapOutputDisplay"
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
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still withdraw existing deposits."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="!isGeoBlocked && isSwapRestricted"
              title="Swap restricted"
              description="Swapping into this vault is not available in your region. You can deposit the vault's underlying asset directly."
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
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <UiToast
              v-if="isUnknownSwapToken && needsSwap"
              title="Unknown token"
              description="This token is not on any recognized token list. It could be fraudulent or malicious. Verify the contract address before proceeding."
              variant="warning"
              size="compact"
            />

            <VaultWarningBanner :warnings="lendWarnings" />

            <VaultFormInfoBlock
              v-if="isVaultLoaded && asset"
              :loading="isEstimatesLoading"
              variant="card"
            >
              <SummaryRow
                label="Projected earnings per month"
                align-top
              >
                <p class="text-content-tertiary">
                  <span class="text-content-primary text-p2">{{ compactNumber(monthlyEarnings, 4) }}</span> {{
                    asset.symbol
                  }}
                  <template v-if="features.hasPriceInfo && vault">
                    ≈ ${{ compactNumber(monthlyEarningsUsd) }}
                  </template>
                </p>
              </SummaryRow>

              <SummaryRow label="Supply APY">
                <SummaryValue
                  :after="estimateSupplyAPYDisplay"
                  suffix="%"
                  estimate-only
                />
              </SummaryRow>
            </VaultFormInfoBlock>

            <template #buttons>
              <VaultFormInfoButton
                v-if="features.hasOverview && (vault || securitizeVault)"
                class="laptop:!hidden"
                :vault="vault || securitizeVault"
                :disabled="isLoading || isSubmitting"
              />
              <VaultFormSubmit
                :disabled="reviewSupplyDisabled"
                :loading="isSubmitting || isPreparing"
              >
                {{ reviewSupplyLabel }}
              </VaultFormSubmit>
            </template>
          </VaultForm>
        </div>
      </div>
    </template>
  </div>
</template>
