<script setup lang="ts">
import { type BorrowVaultPair, isSecuritizeBorrowPair, type AnyBorrowVaultPair } from '~/types/borrow-pair'
import type { VaultAsset } from '~/types/asset'
import type { CollateralOption } from '~/types/collateral-option'
import { collectPythFeedsFromAdapters, isEVault, type EVault, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAssetOraclePrice, getCollateralShareOraclePrice } from '~/utils/sdk-prices'
import { getCollateralOracleRouteSteps, getDebtOracleRouteSteps, getOracleRouteAdapters } from '~/utils/oracle-route-steps'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { getNewSubAccount } from '~/composables/useSubAccounts'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { usePriceImpactGate } from '~/composables/usePriceImpactGate'
import { ltvToPercent } from '~/utils/crypto-utils'
import { useBorrowForm } from '~/composables/borrow/useBorrowForm'
import { useMultiplyForm, type MultiplyBatchSnapshot } from '~/composables/borrow/useMultiplyForm'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { SlippageSettingsModal, VaultUnverifiedDisclaimerModal } from '#components'
import { getAddress, type Address } from 'viem'
import { areRoeCollateralVaultsCorrelatedWithBorrow, mergeRoeCollateralVaults } from '~/utils/position-roe'
import { getTokenAddressesCorrelationCategoryLabel } from '~/utils/token-categories'
import { COWSWAP_BATCH_UNSUPPORTED_REASON, isCowProviderOrQuote } from '~/entities/cowswap'

const router = useRouter()
const route = useRoute()
const modal = useModal()
const reviewBorrowLabel = 'Review Borrow'
const reviewMultiplyLabel = 'Review Multiply'
const { getBorrowVaultPair, updateVault } = useVaults()
const { getTokenCategoryTags } = useTokenList()
const { effectiveAddress: effectiveOwner } = useEffectiveAddress()
const { chainId } = useEulerAddresses()
const shareLinkQuery = computed(() => {
  const network = route.query.network

  return {
    network: Array.isArray(network) ? network[0] ?? chainId.value : network ?? chainId.value,
  }
})
// Page uses SwapTokenSelector — opt into full wallet-token balance fetch while mounted.
useFullBalances()
const { refreshAllPositions: _refreshAllPositions, depositPositions } = useEulerAccount()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { eulerLensAddresses: _eulerLensAddresses } = useEulerAddresses()
const { getBalance } = useWallets()
const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

const collateralAddress = route.params.collateral as string
const borrowAddress = route.params.borrow as string
useOperationGuard([collateralAddress, borrowAddress])

const formTabFromQuery = (value: unknown): 'borrow' | 'multiply' | undefined => {
  const tabValue = Array.isArray(value) ? value[0] : value
  return tabValue === 'borrow' || tabValue === 'multiply' ? tabValue : undefined
}

// --- Shared state ---
// Collateral wallet balance from the central (layer-aware) wallet entity.
const balance = computed(() => collateralVault.value?.asset.address ? getBalance(collateralVault.value.asset.address as Address) : 0n)
const tab = ref()
const formTab = ref<'borrow' | 'multiply'>(formTabFromQuery(route.query.tab) ?? 'borrow')
const pendingSubAccount = ref<string | null>(null)
const isPendingSubAccountLoading = ref(false)
let pendingSubAccountPromise: Promise<string> | null = null
let unverifiedDisclaimerShown = false

// Load vault pair (non-blocking to avoid Suspense + pageTransition crash on direct navigation)
const pair: Ref<AnyBorrowVaultPair | undefined> = ref()
getBorrowVaultPair(collateralAddress, borrowAddress).then((p) => {
  pair.value = p
}).catch((e) => {
  logWarn('[borrow] failed to load vault pair', e)
  void router.replace({ path: '/borrow', query: route.query })
})

const borrowVault = computed(() => pair.value?.borrow)
const collateralVault = computed(() => pair.value?.collateral)
const isSecuritizeCollateral = computed(() => pair.value ? isSecuritizeBorrowPair(pair.value) : false)
const pairAssets = computed(() => [collateralVault.value?.asset, borrowVault.value?.asset])
// --- Shared functions ---
const normalizeAddress = (addr?: string) => {
  if (!addr) return ''
  try {
    return getAddress(addr)
  }
  catch { return '' }
}

const resolvePendingSubAccount = async (): Promise<string> => {
  if (pendingSubAccount.value) return pendingSubAccount.value
  const owner = effectiveOwner.value
  if (!owner) throw new Error('Wallet not connected')
  if (!pendingSubAccountPromise) {
    isPendingSubAccountLoading.value = true
    pendingSubAccountPromise = getNewSubAccount(owner)
      .then((subAccount) => {
        pendingSubAccount.value = subAccount
        return subAccount
      })
      .finally(() => {
        isPendingSubAccountLoading.value = false
        pendingSubAccountPromise = null
      })
  }
  return pendingSubAccountPromise
}

// --- APYs ---
const collateralSupplyRewardApy = computed(() => getSupplyRewardApy(pair.value?.collateral.address || ''))
const borrowRewardApy = computed(() => getBorrowRewardApy(pair.value?.borrow.address || '', pair.value?.collateral.address || ''))
const collateralSupplyApy = computed(() => withVaultIntrinsicApy(
  getVaultSupplyApy(collateralVault.value),
  collateralVault.value,
  enableIntrinsicApy.value,
))
const collateralSupplyApyWithRewards = computed(() => collateralSupplyApy.value + collateralSupplyRewardApy.value)
const borrowApy = computed(() => withVaultIntrinsicApy(
  getVaultBorrowApy(borrowVault.value),
  borrowVault.value,
  enableIntrinsicApy.value,
))

// --- Geo-blocking ---
const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(collateralAddress, borrowAddress))
const isBorrowRestricted = computed(() => isVaultRestrictedByCountry(borrowAddress))
const isMultiplyRestricted = computed(() =>
  isVaultRestrictedByCountry(collateralAddress) || isVaultRestrictedByCountry(borrowAddress))
const isPairFullyRestricted = computed(() =>
  !isGeoBlocked.value && isVaultRestrictedByCountry(collateralAddress) && isVaultRestrictedByCountry(borrowAddress))

// --- Savings collateral ---
const savingPositions = computed(() => {
  const normalizedCollateral = normalizeAddress(collateralAddress)
  return depositPositions.value.filter(position =>
    position.assets > 0n
    && normalizeAddress(position.vault?.address) === normalizedCollateral,
  )
})

// --- Product labels ---
const borrowProduct = useEulerProductOfVault(computed(() => borrowVault.value?.address || ''))
const collateralProduct = useEulerProductOfVault(computed(() => collateralVault.value?.address || ''))

// --- Composable instantiation ---
const borrow = useBorrowForm({
  pair,
  borrowVault: borrowVault as ComputedRef<EVault | undefined>,
  collateralVault: collateralVault as ComputedRef<EVault | undefined>,
  formTab,
  savingPositions,
  balance,
  pendingSubAccount,
  resolvePendingSubAccount,
  collateralSupplyApy,
  borrowApy,
  collateralSupplyRewardApy,
  borrowRewardApy,
  collateralSupplyApyWithRewards,
  isSecuritizeCollateral,
  isGeoBlocked,
  isBorrowRestricted,
  collateralAddress,
  borrowAddress,
})

const multiply = useMultiplyForm({
  pair,
  borrowVault: borrowVault as ComputedRef<EVault | undefined>,
  collateralVault: collateralVault as ComputedRef<EVault | undefined>,
  formTab,
  resolvePendingSubAccount,
  isPendingSubAccountLoading,
  isGeoBlocked,
  isMultiplyRestricted,
})
const showMultiplyRoe = computed(() =>
  areRoeCollateralVaultsCorrelatedWithBorrow(
    mergeRoeCollateralVaults([
      collateralVault.value,
      multiply.multiplySupplyVault.value,
    ]),
    borrowVault.value,
    getTokenCategoryTags,
  ),
)
const correlatedBadgeTitle = computed(() => {
  const category = getTokenAddressesCorrelationCategoryLabel(
    [
      ...mergeRoeCollateralVaults([
        collateralVault.value,
        multiply.multiplySupplyVault.value,
      ]).map(vault => vault.asset.address),
      borrowVault.value?.asset.address,
    ],
    getTokenCategoryTags,
  )
  return category ? `Correlated category: ${category}` : undefined
})

const { guardWithPriceImpact: guardWithMultiplyPriceImpact } = usePriceImpactGate({
  directPriceImpact: multiply.multiplyPriceImpact,
  multipliedPriceImpact: multiply.multipliedPriceImpact,
  shouldGateUnknown: computed(() =>
    !multiply.multiplyIsSameAsset.value
    && multiply.multiplyEffectiveQuote.value !== null
    && multiply.multiplyPriceImpact.value === null,
  ),
})

const { guardWithPriceImpact: guardWithBorrowSwapPriceImpact } = usePriceImpactGate({
  directPriceImpact: borrow.borrowSwapPriceImpact,
  shouldGateUnknown: computed(() =>
    borrow.borrowNeedsSwap.value
    && borrow.borrowSwapEffectiveQuote.value !== null
    && borrow.borrowSwapPriceImpact.value === null,
  ),
})

// --- Submit disabled ---
const reviewBorrowDisabled = computed(() => isGeoBlocked.value || isBorrowRestricted.value || borrow.isBorrowSwapRestricted.value || borrow.isBorrowPayWithBlocked.value || borrow.isSubmitDisabled.value)
const reviewMultiplyDisabled = computed(() => isGeoBlocked.value || isMultiplyRestricted.value || multiply.isMultiplySubmitDisabled.value)

const borrowDisabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (isBorrowRestricted.value) return { message: 'Borrowing this asset is not available in your region', variant: 'warning' }
  if (borrow.isBorrowPayWithBlocked.value) return { message: 'Paying with this asset is not available in your region', variant: 'warning' }
  if (borrow.isBorrowSwapRestricted.value) return { message: 'Swapping into this collateral vault is not available in your region', variant: 'warning' }
  if (borrow.errorText.value) return { message: borrow.errorText.value, variant: 'error' }
  if (borrow.borrowSimulationError.value) return { message: borrow.borrowSimulationError.value, variant: 'error' }
  if (borrow.borrowNeedsSwap.value && borrow.isBorrowSwapQuoteLoading.value && +borrow.collateralAmount.value > 0) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (borrow.borrowNeedsSwap.value && !borrow.borrowSwapSelectedProvider.value && +borrow.collateralAmount.value > 0) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})

const multiplyDisabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (isMultiplyRestricted.value) return { message: 'Multiply is not available for this pair in your region', variant: 'warning' }
  if (multiply.multiplyErrorText.value) return { message: multiply.multiplyErrorText.value, variant: 'error' }
  if (multiply.multiplyCapErrorText.value) return { message: multiply.multiplyCapErrorText.value, variant: 'error' }
  if (multiply.multiplySimulationError.value) return { message: multiply.multiplySimulationError.value, variant: 'error' }
  if (!multiply.multiplyIsSameAsset.value && multiply.isMultiplyQuoteLoading.value && multiply.multiplyDebtAmountNano.value > 0n) return { message: 'Fetching swap quotes...', variant: 'warning' }
  if (!multiply.multiplyIsSameAsset.value && !multiply.multiplySelectedProvider.value && multiply.multiplyDebtAmountNano.value > 0n) return { message: 'Select a swap quote to continue', variant: 'warning' }
  return undefined
})

// --- Batch ("shopping cart") ---
// CoW swaps can't merge into an EVC batch, so the swap-borrow path requires a
// non-CoW quote; the direct/savings paths just need a valid borrow. The
// effective quote is captured into the fixed batch plan at add-time.
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const isBorrowCowSwapSelected = computed(() =>
  borrow.borrowNeedsSwap.value
  && isCowProviderOrQuote(borrow.borrowSwapSelectedProvider.value, borrow.borrowSwapEffectiveQuote.value),
)
const canAddBorrowToBatch = computed(() => {
  // Region/geo blocks are hard legal restrictions, so they still gate the batch.
  // Real-wallet guards (insufficient balance, vault liquidity) are intentionally
  // NOT checked here: an earlier batch step may supply the funds, and the layered
  // simulation flags the entry if it genuinely can't execute. This is why the
  // button stays enabled even when Review is blocked by "Not enough balance".
  if (isGeoBlocked.value || isBorrowRestricted.value || borrow.isBorrowSwapRestricted.value || borrow.isBorrowPayWithBlocked.value) return false
  if (!borrowVault.value || !collateralVault.value) return false
  // Only the borrow amount is required to add to the batch — collateral can be
  // empty (e.g. borrowing against collateral an earlier batch step supplies).
  if (!(+borrow.borrowAmount.value)) return false
  // Savings-sourced collateral needs a resolved position, else plan capture throws.
  if (borrow.isSavingCollateral.value && !borrow.savingCollateral.value) return false
  if (borrow.borrowNeedsSwap.value) {
    return !!borrow.borrowSwapEffectiveQuote.value && !isBorrowCowSwapSelected.value
  }
  return true
})
const addToBatch = async () => {
  if (!canAddBorrowToBatch.value) return
  await guardWithBorrowSwapPriceImpact(async () => {
    const subAccount = (await resolvePendingSubAccount()) as Address
    const cVault = collateralVault.value
    const bVault = borrowVault.value
    if (!cVault || !bVault) return
    // Capture every input by value NOW — the batch re-simulates asynchronously and
    // we reset the form below, so a lazy read of the reactive refs would see the
    // cleared values (an empty amount builds a no-op borrow).
    const snap = borrow.captureBorrowSnapshot(subAccount)
    const label = `Borrow ${snap.borrowAmount} ${bVault.asset.symbol}`
    await addBatchEntry({ intent: borrow.createBorrowIntent(snap), label, subAccount, review: { type: 'borrow', asset: bVault.asset, amount: snap.borrowAmount, quoteFetchedAt: snap.needsSwap ? borrow.borrowSwapEffectiveQuoteFetchedAt.value : null } })
    borrow.collateralAmount.value = ''
    borrow.borrowAmount.value = ''
    redirectAfterAdd('/portfolio', { subAccount })
  })
}

// --- Multiply tab → batch ---
// Same-asset multiply needs no quote; cross-asset needs a non-CoW quote (CoW
// can't merge into an EVC batch). Region/geo blocks gate it like direct execute.
const isMultiplyCowSwapSelected = computed(() =>
  !multiply.multiplyIsSameAsset.value
  && isCowProviderOrQuote(multiply.multiplySelectedProvider.value, multiply.multiplyEffectiveQuote.value),
)
const canAddMultiplyToBatch = computed(() => {
  if (isGeoBlocked.value || isMultiplyRestricted.value) return false
  if (multiply.multiplyDebtAmountNano.value <= 0n) return false
  if (!multiply.multiplySupplyVault.value || !multiply.multiplyLongVault.value || !multiply.multiplyShortVault.value) return false
  if (multiply.multiplyIsSameAsset.value) return true
  return !!multiply.multiplyEffectiveQuote.value && !isMultiplyCowSwapSelected.value
})
const addMultiplyToBatch = async () => {
  if (!canAddMultiplyToBatch.value) return
  await guardWithMultiplyPriceImpact(async () => {
    const supplyVault = multiply.multiplySupplyVault.value
    const longVault = multiply.multiplyLongVault.value
    const shortVault = multiply.multiplyShortVault.value
    if (!supplyVault || !longVault || !shortVault) return
    const subAccount = (await resolvePendingSubAccount()) as Address
    const sameAsset = multiply.multiplyIsSameAsset.value
    const saving = multiply.multiplySavingPosition.value
    const snap: MultiplyBatchSnapshot = {
      subAccount,
      supplyVault: supplyVault as EVault,
      longVault: longVault as EVault,
      shortVault: shortVault as EVault,
      inputAmount: multiply.multiplyInputAmount.value,
      debtAmount: multiply.multiplyDebtAmountNano.value,
      isSavingCollateral: multiply.isMultiplySavingCollateral.value,
      savingFrom: saving?.subAccount as Address | undefined,
      savingAssets: saving?.assets,
      savingShares: multiply.multiplySavingBalance.value,
      quote: sameAsset ? undefined : multiply.multiplyEffectiveQuote.value ?? undefined,
    }
    const quoteIntents = snap.quote
      ? multiply.multiplyQuoteCardsSorted.value.find(card => card.quote === snap.quote)?.intents
      : undefined
    await addBatchEntry({ intent: quoteIntents?.[0] ?? multiply.createMultiplyIntent(snap), label: `Multiply → ${longVault.asset.symbol}`, subAccount, multiply: true, review: { type: 'borrow', asset: shortVault.asset, amount: multiply.multiplyInputAmount.value, swapToAsset: longVault.asset, quoteFetchedAt: sameAsset ? null : multiply.multiplyEffectiveQuoteFetchedAt.value } })
    redirectAfterAdd('/portfolio', { subAccount })
  })
}

// --- Tabs ---
const formTabs = computed(() => [
  { label: 'Borrow', value: 'borrow' },
  { label: 'Multiply', value: 'multiply' },
])

const tabs = computed(() => {
  if (!pair.value) return []
  const list = [
    {
      label: 'Pair details',
      value: undefined,
      assets: [pair.value.collateral.asset, pair.value.borrow.asset],
    },
    {
      label: pair.value.collateral.asset.symbol,
      value: 'collateral',
      assets: [pair.value.collateral.asset],
    },
    {
      label: pair.value.borrow.asset.symbol,
      value: 'borrow',
      assets: [pair.value.borrow.asset],
    },
  ]
  if (formTab.value === 'multiply' && multiply.multiplySupplyVault.value) {
    const supplyAddress = normalizeAddress(multiply.multiplySupplyVault.value.address)
    const collAddr = normalizeAddress(pair.value.collateral.address)
    const borrowAddr = normalizeAddress(pair.value.borrow.address)
    if (supplyAddress && supplyAddress !== collAddr && supplyAddress !== borrowAddr) {
      list.splice(1, 0, {
        label: multiply.multiplySupplyVault.value.asset.symbol,
        value: 'multiply-collateral',
        assets: [multiply.multiplySupplyVault.value.asset],
      })
    }
  }
  return list
})

watch(tabs, (next) => {
  if (!tab.value) return
  const values = next.map(item => item.value)
  if (!values.includes(tab.value)) {
    tab.value = undefined
  }
}, { immediate: true })

// --- Balance ---
// `balance` and the form composables' asset balances are now reactive computeds
// over the central (layer-aware) wallet entity, so there's nothing to fetch.
const updateBalance = async () => {}

// --- Submit dispatcher ---
const onSubmit = async () => {
  if (formTab.value === 'borrow') {
    await guardWithBorrowSwapPriceImpact(() => borrow.submit())
  }
  else if (formTab.value === 'multiply') {
    await guardWithMultiplyPriceImpact(() => multiply.submitMultiply())
  }
}

// --- Pyth oracle refresh logic ---
const hasPythOracleRouteSteps = (steps: ReturnType<typeof getDebtOracleRouteSteps>): boolean => {
  const feeds = collectPythFeedsFromAdapters(getOracleRouteAdapters(steps))
  return feeds.length > 0
}

const hasBorrowPythOracles = (vault: EVault | undefined): boolean =>
  !!vault && hasPythOracleRouteSteps(getDebtOracleRouteSteps(vault))

const hasCollateralPythOracles = (
  borrowVault: EVault | undefined,
  collateralVault: EVault | SecuritizeCollateralVault | undefined,
): boolean =>
  !!borrowVault
  && !!collateralVault
  && hasPythOracleRouteSteps(getCollateralOracleRouteSteps(borrowVault, collateralVault))

const hasBorrowPriceFailure = (vault: EVault | undefined): boolean => {
  if (!vault) return false
  const price = getAssetOraclePrice(vault)
  return (
    price?.amountOutMid === undefined
    || price?.amountOutMid === null
  )
}

const hasCollateralPriceFailure = (bVault: EVault | undefined, collAddr: string | undefined): boolean => {
  if (!bVault || !collAddr) return false
  const collateralPrice = getCollateralShareOraclePrice(bVault, { address: collAddr })
  if (!collateralPrice) return true
  return (
    collateralPrice.queryFailure
    || collateralPrice.amountOutMid === undefined
    || collateralPrice.amountOutMid === null
  )
}

const needsRefresh = (vault: EVault | undefined): boolean => {
  return hasBorrowPythOracles(vault) || hasBorrowPriceFailure(vault)
}

const needsRefreshForCollateral = (
  bVault: EVault | undefined,
  collateralVault: EVault | SecuritizeCollateralVault | undefined,
): boolean => {
  return hasCollateralPythOracles(bVault, collateralVault)
    || hasCollateralPriceFailure(bVault, collateralVault?.address)
}

const refreshedVaultAddresses = new Set<string>()

watch(pair, (newVal, oldVal) => {
  if (oldVal && newVal) {
    const newBorrow = newVal.borrow.address.toLowerCase()
    const oldBorrow = oldVal.borrow.address.toLowerCase()
    if (newBorrow !== oldBorrow) {
      refreshedVaultAddresses.clear()
    }
  }
}, { immediate: false })

onUnmounted(() => {
  refreshedVaultAddresses.clear()
})

watch(pair, async (val) => {
  if (!val) return

  let current = val
  const borrowAddr = current.borrow.address.toLowerCase()
  const borrowNeedsRefresh = needsRefresh(current.borrow) || needsRefreshForCollateral(current.borrow, current.collateral)

  if (borrowNeedsRefresh && !refreshedVaultAddresses.has(borrowAddr)) {
    refreshedVaultAddresses.add(borrowAddr)
    const refreshedBorrow = await updateVault(current.borrow.address)
    pair.value = { ...current, borrow: refreshedBorrow } as AnyBorrowVaultPair
    current = pair.value
  }

  if (isEVault(current.collateral)) {
    const collateralVaultTyped = current.collateral as EVault
    const collateralAddr = collateralVaultTyped.address.toLowerCase()

    if (needsRefresh(collateralVaultTyped) && !refreshedVaultAddresses.has(collateralAddr)) {
      refreshedVaultAddresses.add(collateralAddr)
      const refreshedCollateral = await updateVault(collateralVaultTyped.address)
      pair.value = { ...pair.value, collateral: refreshedCollateral } as AnyBorrowVaultPair
      current = pair.value
    }
  }

  const supplyAddress = normalizeAddress(multiply.multiplySupplyVault.value?.address)
  const isSupplyAllowed = supplyAddress
    ? current.borrow.collaterals.some(ltv => normalizeAddress(ltv.address) === supplyAddress)
    : false
  if (!multiply.multiplySupplyVault.value || !isSupplyAllowed) {
    multiply.initMultiplySupplyVault(current.collateral as EVault)
  }
  const { isVerifiedVault } = useVaultRegistry()
  if (!isVerifiedVault(current.collateral.address) || !isVerifiedVault(current.borrow.address)) {
    if (!unverifiedDisclaimerShown) {
      unverifiedDisclaimerShown = true
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
  await updateBalance()
}, { immediate: true })

watch(effectiveOwner, () => {
  pendingSubAccount.value = null
  pendingSubAccountPromise = null
  updateBalance()
})

watch(formTab, () => {
  borrow.resetOnTabSwitch()
  multiply.resetOnTabSwitch()

  const currentRouteTab = formTabFromQuery(route.query.tab) ?? 'borrow'
  if (formTab.value === currentRouteTab) return

  const query = { ...route.query }
  if (formTab.value === 'borrow') {
    delete query.tab
  }
  else {
    query.tab = formTab.value
  }
  void router.replace({ query })
})

watch(
  () => [route.params.collateral, route.params.borrow, route.query.tab],
  () => {
    formTab.value = formTabFromQuery(route.query.tab) ?? 'borrow'
  },
)
</script>

<template>
  <div class="relative">
    <div
      v-if="!pair"
      class="flex justify-center items-center min-h-[50dvh]"
    >
      <UiLoader />
    </div>
    <template v-else>
      <BackButton
        class="hidden tablet:inline-flex tablet:absolute tablet:top-8 tablet:right-full tablet:mr-12"
        fallback="/borrow"
      />
      <div
        v-if="collateralVault && borrowVault"
        class="mb-24"
      >
        <VaultLabelsAndAssets
          back
          back-fallback="/borrow"
          :vault="collateralVault"
          :pair-vault="borrowVault"
          :assets="pairAssets as VaultAsset[]"
          size="large"
        >
          <template #symbol-trailing>
            <CorrelatedPairBadge
              v-if="showMultiplyRoe"
              compact
              :title="correlatedBadgeTitle"
            />
          </template>
          <UiShareLinkButton
            class="-ml-4 !w-24 !h-24"
            :path="`/borrow/${collateralVault.address}/${borrowVault.address}`"
            :query="shareLinkQuery"
            label="Copy pair link"
            variant="ghost"
          />
        </VaultLabelsAndAssets>
      </div>

      <div class="flex gap-32">
        <div
          v-if="pair"
          class="hidden laptop:!block laptop:flex-[55] min-w-0"
        >
          <UiTabs
            v-if="tabs.length"
            v-model="tab"
            class="mb-12 min-w-0"
            rounded
            pills
            :list="tabs"
          >
            <template #default="{ tab: slotTab }">
              <div class="flex items-center gap-8">
                <AssetAvatar :asset="slotTab.assets" />

                {{ slotTab.label }}
              </div>
            </template>
          </UiTabs>
          <Transition
            name="page"
            mode="out-in"
          >
            <VaultOverviewPair
              v-if="!tab"
              :pair="pair"
              style="flex-grow: 1"
              desktop-overview
            />
            <SecuritizeVaultOverview
              v-else-if="tab === 'collateral' && isSecuritizeCollateral"
              :vault="(pair.collateral as SecuritizeCollateralVault)"
              desktop-overview
            />
            <VaultOverview
              v-else-if="tab === 'collateral'"
              :vault="(pair.collateral as EVault)"
              desktop-overview
              @vault-click="(address: string) => router.push({ path: `/lend/${address}`, query: { network: route.query.network } })"
            />
            <VaultOverview
              v-else-if="tab === 'multiply-collateral' && multiply.multiplySupplyVault.value"
              :vault="multiply.multiplySupplyVault.value"
              desktop-overview
              @vault-click="(address: string) => router.push({ path: `/lend/${address}`, query: { network: route.query.network } })"
            />
            <VaultOverview
              v-else-if="tab === 'borrow'"
              :vault="pair.borrow"
              desktop-overview
              @vault-click="(address: string) => router.push({ path: `/lend/${address}`, query: { network: route.query.network } })"
            />
          </Transition>
        </div>
        <div class="flex flex-col gap-16 w-full laptop:flex-[45] laptop:sticky laptop:top-[88px] laptop:self-start">
          <VaultForm
            class="flex flex-col gap-16 w-full min-w-0"
            @submit.prevent="onSubmit"
          >
            <template v-if="pair">
              <UiTabs
                v-model="formTab"
                class="mb-12"
                rounded
                pills
                :list="formTabs"
              />

              <template v-if="formTab === 'borrow'">
                <AssetInput
                  v-if="collateralVault"
                  v-model="borrow.collateralAmount.value"
                  :desc="collateralProduct.name"
                  :label="`Supply ${collateralVault.asset.symbol}`"
                  :asset="borrow.borrowNeedsSwap.value && borrow.borrowSelectedAsset.value ? borrow.borrowSelectedAsset.value : collateralVault.asset"
                  :price-override="borrow.borrowNeedsSwap.value ? borrow.borrowSwapAssetUsdPrice.value : borrow.collateralUnitPrice.value"
                  :balance="borrow.borrowActiveBalance.value"
                  :collateral-options="borrow.borrowNeedsSwap.value ? undefined : (borrow.collateralOptions.value as CollateralOption[])"
                  :selected-source="borrow.isSavingCollateral.value ? 'saving' : 'wallet'"
                  :selected-sub-account="borrow.selectedSavingSubAccount.value"
                  :selected-vault-address="collateralVault?.address"
                  maxable
                  @input="borrow.onCollateralInput"
                  @change-collateral="borrow.onChangeCollateral"
                />

                <!-- Pay with token selector -->
                <div
                  v-if="collateralVault && !isSecuritizeCollateral"
                  class="flex items-center gap-8"
                >
                  <span class="text-p3 text-content-tertiary">Pay with</span>
                  <button
                    type="button"
                    class="flex items-center gap-6 bg-card text-p3 font-semibold px-12 h-36 rounded-[40px] whitespace-nowrap"
                    @click="borrow.openBorrowSwapTokenSelector"
                  >
                    <AssetAvatar
                      :asset="{ address: borrow.borrowSelectedAsset.value?.address || collateralVault.asset.address, symbol: borrow.borrowSelectedAsset.value?.symbol || collateralVault.asset.symbol }"
                      size="20"
                    />
                    {{ borrow.borrowSelectedAsset.value?.symbol || collateralVault.asset.symbol }}
                    <SvgIcon
                      class="text-content-tertiary !w-16 !h-16"
                      name="arrow-down"
                    />
                  </button>
                </div>

                <!-- Swap info for borrow -->
                <template v-if="borrow.borrowNeedsSwap.value && collateralVault">
                  <SwapRouteSelector
                    :items="borrow.borrowSwapRouteItems.value"
                    :selected-provider="borrow.borrowSwapSelectedProvider.value"
                    :status-label="borrow.borrowSwapQuotesStatusLabel.value"
                    :is-loading="borrow.isBorrowSwapQuoteLoading.value"
                    empty-message="Enter amount to fetch quotes"
                    @select="borrow.selectBorrowSwapQuote"
                    @refresh="borrow.onRefreshBorrowSwapQuotes"
                  />

                  <VaultFormInfoBlock
                    v-if="borrow.borrowSwapEstimatedCollateral.value || borrow.borrowSwapQuoteError.value"
                    :loading="borrow.isBorrowSwapQuoteLoading.value"
                    variant="card"
                  >
                    <SwapDetailsSummary
                      :input-display="borrow.borrowSwapInputDisplay.value"
                      :input-exact-display="borrow.borrowSwapInputExactDisplay.value"
                      :output-display="borrow.borrowSwapOutputDisplay.value"
                      :output-exact-display="borrow.borrowSwapOutputExactDisplay.value"
                      :price-impact="borrow.borrowSwapPriceImpact.value"
                      :slippage="borrow.borrowSwapSlippage.value"
                      :routed-via="borrow.borrowSwapRoutedVia.value"
                      @open-slippage-settings="openSlippageSettings"
                    />
                  </VaultFormInfoBlock>

                  <UiAlert
                    v-if="borrow.borrowSwapQuoteError.value"
                    title="Swap quote"
                    variant="warning"
                    :description="borrow.borrowSwapQuoteError.value"
                    size="compact"
                  />
                </template>

                <UiAlert
                  v-if="borrow.isUnknownBorrowSwapToken.value && borrow.borrowNeedsSwap.value"
                  title="Unknown token"
                  description="This token is not on any recognized token list. It could be fraudulent or malicious. Verify the contract address before proceeding."
                  variant="warning"
                  size="compact"
                />

                <UiRange
                  v-model="borrow.ltv.value"
                  label="LTV"
                  :step="0.1"
                  :max="ltvToPercent(pair.ltv.borrowLTV)"
                  :number-filter="(n: number) => `${formatNumber(n, 2, 0)}%`"
                  @update:model-value="borrow.onLtvInput"
                />

                <AssetInput
                  v-if="borrowVault"
                  v-model="borrow.borrowAmount.value"
                  :desc="borrowProduct.name"
                  :label="`Borrow ${borrowVault.asset.symbol}`"
                  :asset="borrowVault.asset"
                  :vault="borrowVault"
                  @input="borrow.onBorrowInput"
                />

                <UiAlert
                  v-if="isGeoBlocked"
                  title="Region restricted"
                  description="This operation is not available in your region. You can still repay existing debt."
                  variant="warning"
                  size="compact"
                />
                <UiAlert
                  v-if="isPairFullyRestricted"
                  title="Region restricted"
                  description="This pair is not available in your region."
                  variant="warning"
                  size="compact"
                />
                <UiAlert
                  v-if="!isGeoBlocked && !isPairFullyRestricted && isBorrowRestricted"
                  title="Asset restricted"
                  description="Borrowing this asset is not available in your region."
                  variant="warning"
                  size="compact"
                />
                <UiAlert
                  v-if="!isGeoBlocked && !isPairFullyRestricted && !isBorrowRestricted && borrow.isBorrowPayWithBlocked.value"
                  title="Asset restricted"
                  description="Paying with this asset is not available in your region. Pick a different token."
                  variant="warning"
                  size="compact"
                />
                <UiAlert
                  v-if="!isGeoBlocked && !isPairFullyRestricted && !isBorrowRestricted && !borrow.isBorrowPayWithBlocked.value && borrow.isBorrowSwapRestricted.value"
                  title="Swap restricted"
                  description="Swapping into this collateral vault is not available in your region. You can provide the vault's underlying asset directly."
                  variant="warning"
                  size="compact"
                />
                <UiAlert
                  v-show="borrow.errorText.value"
                  title="Error"
                  variant="error"
                  :description="borrow.errorText.value || ''"
                  size="compact"
                />
                <UiAlert
                  v-if="borrow.borrowSimulationError.value"
                  title="Error"
                  variant="error"
                  :description="borrow.borrowSimulationError.value"
                  size="compact"
                />

                <VaultWarningBanner :warnings="borrow.borrowFormWarnings.value" />

                <VaultFormInfoBlock
                  v-if="pair"
                  :loading="borrow.isEstimatesLoading.value"
                  variant="card"
                >
                  <ProjectedYieldSummaryRow
                    label="Net APY"
                    :after="borrow.netAPY.value"
                    :details="borrow.projectedYieldDetails.value"
                    estimate-only
                  />
                  <SummaryRow label="Oracle price">
                    <SummaryPriceValue
                      :value="!borrow.priceFixed.value.isZero() ? formatSmartAmount(borrow.borrowPriceInvert.invertValue(borrow.priceFixed.value.toUnsafeFloat())) : undefined"
                      :symbol="borrow.borrowPriceInvert.displaySymbol"
                      invertible
                      @invert="borrow.borrowPriceInvert.toggle"
                    />
                  </SummaryRow>
                  <SummaryRow label="Liq. price">
                    <SummaryPriceValue
                      :value="borrow.borrowPriceInvert.invertValue(borrow.liquidationPrice.value) != null ? formatSmartAmount(borrow.borrowPriceInvert.invertValue(borrow.liquidationPrice.value)!) : undefined"
                      :symbol="borrow.borrowPriceInvert.displaySymbol"
                      invertible
                      @invert="borrow.borrowPriceInvert.toggle"
                    />
                  </SummaryRow>
                  <SummaryRow label="Liq. buffer">
                    <SummaryValue
                      :after="formatLiqBuffer(
                        borrow.borrowPriceInvert.invertValue(borrow.priceFixed.value.toUnsafeFloat()),
                        borrow.borrowPriceInvert.invertValue(borrow.liquidationPrice.value),
                      )"
                      suffix="%"
                      estimate-only
                    />
                  </SummaryRow>
                  <SummaryRow label="LTV">
                    <SummaryValue
                      :after="formatNumber(borrow.ltv.value)"
                      suffix="%"
                      estimate-only
                    />
                  </SummaryRow>
                  <SummaryRow label="Health score">
                    <SummaryValue
                      :after="formatHealthScore(borrow.health.value)"
                      estimate-only
                    />
                  </SummaryRow>
                </VaultFormInfoBlock>
              </template>

              <template v-else-if="multiply.multiplySupplyVault.value && multiply.multiplyLongVault.value && multiply.multiplyShortVault.value">
                <div class="grid gap-16 laptop:items-start">
                  <div class="flex flex-col gap-16 w-full">
                    <AssetInput
                      v-model="multiply.multiplyInputAmount.value"
                      :desc="multiply.multiplySupplyProduct.name"
                      :label="`Supply ${multiply.multiplySupplyVault.value.asset.symbol}`"
                      :asset="multiply.multiplySupplyVault.value.asset"
                      :vault="multiply.multiplySupplyVault.value"
                      :balance="multiply.multiplyBalance.value"
                      :collateral-options="multiply.multiplyCollateralOptions.value"
                      :selected-source="multiply.isMultiplySavingCollateral.value ? 'saving' : 'wallet'"
                      :selected-sub-account="multiply.multiplySelectedSavingSubAccount.value"
                      :selected-vault-address="multiply.multiplySupplyVault.value?.address"
                      maxable
                      @input="multiply.onMultiplyInput"
                      @change-collateral="multiply.onMultiplyCollateralChange"
                    />

                    <UiRange
                      v-model="multiply.multiplier.value"
                      label="Multiplier"
                      :step="0.1"
                      :min="multiply.multiplyMinMultiplier.value"
                      :max="multiply.multiplyMaxMultiplier.value"
                      :number-filter="(n: number) => `${formatNumber(n, 2, 0)}x`"
                      @update:model-value="multiply.onMultiplierInput"
                    />

                    <SwapRouteSelector
                      :items="multiply.multiplyRouteItems.value"
                      :selected-provider="multiply.multiplySelectedProvider.value"
                      :status-label="multiply.multiplyQuotesStatusLabel.value"
                      :is-loading="multiply.isMultiplyQuoteLoading.value"
                      :empty-message="multiply.multiplyRouteEmptyMessage.value"
                      @select="multiply.selectMultiplyQuote"
                      @refresh="multiply.onRefreshMultiplyQuotes"
                    />

                    <AssetInput
                      v-model="multiply.multiplyLongAmount.value"
                      :desc="multiply.multiplyLongProduct.name"
                      label="Additional collateral"
                      :asset="multiply.multiplyLongVault.value.asset"
                      :vault="(multiply.multiplyLongVault.value as EVault)"
                      :readonly="true"
                    />

                    <AssetInput
                      v-model="multiply.multiplyShortAmount.value"
                      :desc="multiply.multiplyShortProduct.name"
                      label="Debt"
                      :asset="multiply.multiplyShortVault.value.asset"
                      :vault="multiply.multiplyShortVault.value"
                      :readonly="true"
                    />

                    <UiAlert
                      v-if="isGeoBlocked"
                      title="Region restricted"
                      description="This operation is not available in your region. You can still repay existing debt."
                      variant="warning"
                      size="compact"
                    />
                    <UiAlert
                      v-if="isPairFullyRestricted"
                      title="Region restricted"
                      description="This pair is restricted in your region."
                      variant="warning"
                      size="compact"
                    />
                    <UiAlert
                      v-if="!isGeoBlocked && !isPairFullyRestricted && isMultiplyRestricted"
                      title="Asset restricted"
                      description="Multiply is not available for this pair in your region."
                      variant="warning"
                      size="compact"
                    />
                    <UiAlert
                      v-show="multiply.multiplyErrorText.value"
                      title="Error"
                      variant="error"
                      :description="multiply.multiplyErrorText.value || ''"
                      size="compact"
                    />
                    <UiAlert
                      v-if="multiply.multiplySimulationError.value"
                      title="Error"
                      variant="error"
                      :description="multiply.multiplySimulationError.value"
                      size="compact"
                    />

                    <UiAlert
                      v-if="multiply.multiplyQuoteError.value"
                      title="Swap quote"
                      variant="warning"
                      :description="multiply.multiplyQuoteError.value"
                      size="compact"
                    />

                    <VaultWarningBanner :warnings="multiply.multiplyFormWarnings.value" />
                  </div>

                  <div class="flex flex-col gap-16 w-full">
                    <VaultFormInfoBlock
                      :loading="multiply.isMultiplyQuoteLoading.value"
                      variant="card"
                    >
                      <ProjectedYieldSummaryRow
                        v-if="showMultiplyRoe"
                        label="ROE"
                        :after="multiply.multiplyRoeAfter.value !== null && multiply.multiplySwapReady.value ? multiply.multiplyRoeAfter.value : multiply.multiplyRoeBefore.value"
                        :details="multiply.multiplySwapReady.value ? multiply.projectedYieldDetails.value?.roe : null"
                        estimate-only
                      />
                      <ProjectedYieldSummaryRow
                        v-else
                        label="Net APY"
                        :after="multiply.multiplyNetApyAfter.value !== null && multiply.multiplySwapReady.value ? multiply.multiplyNetApyAfter.value : null"
                        :details="multiply.multiplySwapReady.value ? multiply.projectedYieldDetails.value?.netApy : null"
                        estimate-only
                      />
                      <SummaryRow
                        label="Swap price"
                        align-top
                      >
                        <SummaryPriceValue
                          :value="multiply.multiplyCurrentPrice.value ? formatSmartAmount(multiply.multiplyPriceInvert.invertValue(multiply.multiplyCurrentPrice.value.value)) : undefined"
                          :symbol="multiply.multiplyPriceInvert.displaySymbol"
                          invertible
                          @invert="multiply.multiplyPriceInvert.toggle"
                        />
                      </SummaryRow>
                      <SummaryRow label="Liq. price">
                        <SummaryPriceValue
                          :value="multiply.multiplyNextLiquidationPrice.value !== null && multiply.multiplySwapReady.value ? formatSmartAmount(multiply.multiplyPriceInvert.invertValue(multiply.multiplyNextLiquidationPrice.value)) : (multiply.multiplyPriceInvert.invertValue(multiply.multiplyCurrentLiquidationPrice.value) != null ? formatSmartAmount(multiply.multiplyPriceInvert.invertValue(multiply.multiplyCurrentLiquidationPrice.value)!) : undefined)"
                          :symbol="multiply.multiplyPriceInvert.displaySymbol"
                          estimate-only
                          invertible
                          @invert="multiply.multiplyPriceInvert.toggle"
                        />
                      </SummaryRow>
                      <SummaryRow label="Liq. buffer">
                        <SummaryValue
                          :after="formatLiqBuffer(
                            multiply.multiplyPriceInvert.invertValue(multiply.multiplyCurrentPrice.value?.value ?? null),
                            multiply.multiplyNextLiquidationPrice.value !== null && multiply.multiplySwapReady.value
                              ? multiply.multiplyPriceInvert.invertValue(multiply.multiplyNextLiquidationPrice.value)
                              : multiply.multiplyPriceInvert.invertValue(multiply.multiplyCurrentLiquidationPrice.value),
                          )"
                          suffix="%"
                          estimate-only
                        />
                      </SummaryRow>
                      <SummaryRow label="LTV">
                        <SummaryValue
                          :after="multiply.multiplyNextLtv.value !== null && multiply.multiplySwapReady.value ? formatNumber(multiply.multiplyNextLtv.value) : undefined"
                          suffix="%"
                          estimate-only
                        />
                      </SummaryRow>
                      <SummaryRow label="Health score">
                        <SummaryValue
                          :after="multiply.multiplyNextHealth.value !== null && multiply.multiplySwapReady.value ? formatHealthScore(multiply.multiplyNextHealth.value) : undefined"
                          estimate-only
                        />
                      </SummaryRow>
                      <SwapDetailsSummary
                        :input-display="multiply.multiplySwapSummary.value?.from ?? null"
                        :input-exact-display="multiply.multiplySwapSummary.value?.fromExact ?? null"
                        :output-display="multiply.multiplySwapSummary.value?.to ?? null"
                        :output-exact-display="multiply.multiplySwapSummary.value?.toExact ?? null"
                        :price-impact="multiply.multiplyPriceImpact.value"
                        :slippage="multiply.multiplySlippage.value"
                        :routed-via="multiply.multiplyRoutedVia.value"
                        :multiplied-price-impact="multiply.multipliedPriceImpact.value"
                        @open-slippage-settings="openSlippageSettings"
                      />
                    </VaultFormInfoBlock>
                  </div>
                </div>
              </template>

              <template v-else-if="formTab === 'multiply'">
                <div
                  class="flex min-h-[624px] items-center justify-center rounded-16 bg-surface-secondary shadow-card"
                  aria-busy="true"
                >
                  <UiLoader class="text-content-muted" />
                </div>
              </template>
            </template>

            <template #buttons>
              <VaultFormInfoButton
                :pair="(pair as BorrowVaultPair)"
                :extra-vault="formTab === 'multiply' ? multiply.multiplySupplyVault.value : undefined"
                class="laptop:!hidden"
              />
              <VaultFormSubmit
                v-if="formTab === 'borrow'"
                :disabled="reviewBorrowDisabled"
                :disabled-reason="borrowDisabledReasonInfo?.message"
                :disabled-reason-variant="borrowDisabledReasonInfo?.variant"
                :loading="borrow.isSubmitting.value || borrow.isPreparing.value"
                :can-add-to-batch="canAddBorrowToBatch"
                :add-to-batch-disabled-reason="isBorrowCowSwapSelected ? COWSWAP_BATCH_UNSUPPORTED_REASON : undefined"
                @add-to-batch="addToBatch"
              >
                {{ reviewBorrowLabel }}
              </VaultFormSubmit>
              <VaultFormSubmit
                v-else-if="formTab === 'multiply'"
                :disabled="reviewMultiplyDisabled"
                :disabled-reason="multiplyDisabledReasonInfo?.message"
                :disabled-reason-variant="multiplyDisabledReasonInfo?.variant"
                :loading="multiply.isMultiplySubmitting.value || multiply.isMultiplyPreparing.value"
                :can-add-to-batch="canAddMultiplyToBatch"
                :add-to-batch-disabled-reason="isMultiplyCowSwapSelected ? COWSWAP_BATCH_UNSUPPORTED_REASON : undefined"
                @add-to-batch="addMultiplyToBatch"
              >
                {{ reviewMultiplyLabel }}
              </VaultFormSubmit>
            </template>
          </VaultForm>
        </div>
      </div>
    </template>
  </div>
</template>
