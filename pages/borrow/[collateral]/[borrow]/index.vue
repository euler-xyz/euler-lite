<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getAddress } from 'viem'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultUnverifiedDisclaimerModal, SlippageSettingsModal } from '#components'
import { useTermsOfUseGate } from '~/composables/useTermsOfUseGate'

import { type AnyBorrowVaultPair, type BorrowVaultPair, type VaultAsset, type CollateralOption, type Vault, type SecuritizeVault, isSecuritizeBorrowPair } from '~/entities/vault'
import { collectPythFeedIds } from '~/entities/oracle'
import { getNewSubAccount } from '~/entities/account'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useBorrowForm } from '~/composables/borrow/useBorrowForm'
import { useMultiplyForm } from '~/composables/borrow/useMultiplyForm'

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { getSubmitLabel, getSubmitDisabled } = useTermsOfUseGate()
const reviewBorrowLabel = getSubmitLabel('Review Borrow')
const reviewMultiplyLabel = getSubmitLabel('Review Multiply')
const { getBorrowVaultPair, updateVault } = useVaults()
const { address, isConnected } = useAccount()
const { refreshAllPositions: _refreshAllPositions, depositPositions } = useEulerAccount()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
const { eulerLensAddresses: _eulerLensAddresses } = useEulerAddresses()
const { fetchSingleBalance, fetchVaultShareBalance } = useWallets()
const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

const collateralAddress = route.params.collateral as string
const borrowAddress = route.params.borrow as string

// --- Shared state ---
const balance = ref(0n)
const savingBalance = ref(0n)
const savingAssets = ref(0n)
const tab = ref()
const formTab = ref<'borrow' | 'multiply'>('borrow')
const pendingSubAccount = ref<string | null>(null)
const isPendingSubAccountLoading = ref(false)
let pendingSubAccountPromise: Promise<string> | null = null

// Load vault pair
const initialPair = await getBorrowVaultPair(collateralAddress, borrowAddress)
const pair: Ref<AnyBorrowVaultPair | undefined> = ref(initialPair)

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
  if (!address.value) throw new Error('Wallet not connected')
  if (!pendingSubAccountPromise) {
    isPendingSubAccountLoading.value = true
    pendingSubAccountPromise = getNewSubAccount(address.value)
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
const collateralSupplyApy = computed(() => withIntrinsicSupplyApy(
  nanoToValue(collateralVault.value?.interestRateInfo.supplyAPY || 0n, 25),
  collateralVault.value?.asset.address,
))
const collateralSupplyApyWithRewards = computed(() => collateralSupplyApy.value + collateralSupplyRewardApy.value)
const borrowApy = computed(() => withIntrinsicBorrowApy(
  nanoToValue(borrowVault.value?.interestRateInfo.borrowAPY || 0n, 25),
  borrowVault.value?.asset.address,
))

// --- Geo-blocking ---
const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(collateralAddress, borrowAddress))
const isBorrowRestricted = computed(() => isVaultRestrictedByCountry(borrowAddress))
const isMultiplyRestricted = computed(() =>
  isVaultRestrictedByCountry(collateralAddress) || isVaultRestrictedByCountry(borrowAddress))
const isPairFullyRestricted = computed(() =>
  !isGeoBlocked.value && isVaultRestrictedByCountry(collateralAddress) && isVaultRestrictedByCountry(borrowAddress))

// --- Savings collateral ---
const savingCollateral = computed(() => {
  return depositPositions.value.find(position => position.vault.address === route.params.collateral)
})

// --- Product labels ---
const borrowProduct = useEulerProductOfVault(computed(() => borrowVault.value?.address || ''))
const collateralProduct = useEulerProductOfVault(computed(() => collateralVault.value?.address || ''))

// --- Composable instantiation ---
const borrow = useBorrowForm({
  pair,
  borrowVault: borrowVault as ComputedRef<Vault | undefined>,
  collateralVault: collateralVault as ComputedRef<Vault | undefined>,
  formTab,
  savingCollateral: savingCollateral as ComputedRef<{ assets: bigint, subAccount?: string, shares: bigint } | undefined>,
  balance,
  savingBalance,
  savingAssets,
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
  borrowVault: borrowVault as ComputedRef<Vault | undefined>,
  collateralVault: collateralVault as ComputedRef<Vault | undefined>,
  formTab,
  resolvePendingSubAccount,
  isPendingSubAccountLoading,
  isGeoBlocked,
  isMultiplyRestricted,
})

// --- Submit disabled ---
const reviewBorrowDisabled = getSubmitDisabled(computed(() => isGeoBlocked.value || isBorrowRestricted.value || borrow.isBorrowSwapRestricted.value || borrow.isSubmitDisabled.value))
const reviewMultiplyDisabled = getSubmitDisabled(computed(() => isGeoBlocked.value || isMultiplyRestricted.value || multiply.isMultiplySubmitDisabled.value))

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
const updateBalance = async () => {
  if (!isConnected.value) {
    balance.value = 0n
    savingBalance.value = 0n
    multiply.multiplyAssetBalance.value = 0n
    return
  }

  if (collateralVault.value?.asset.address) {
    balance.value = await fetchSingleBalance(collateralVault.value.asset.address)
  }
  else {
    balance.value = 0n
  }

  if (collateralVault.value?.address) {
    savingBalance.value = await fetchVaultShareBalance(
      collateralVault.value.address,
      savingCollateral.value?.subAccount,
    )
  }
  else {
    savingBalance.value = 0n
  }

  await Promise.all([
    multiply.updateMultiplyAssetBalance(),
    borrow.updateBorrowSwapAssetBalance(),
  ])
}

// --- Submit dispatcher ---
const onSubmit = () => {
  if (formTab.value === 'borrow') {
    borrow.submit()
  }
  else if (formTab.value === 'multiply') {
    multiply.submitMultiply()
  }
}

// --- Pyth oracle refresh logic ---
const hasPythOracles = (vault: Vault | undefined): boolean => {
  if (!vault) return false
  const feeds = collectPythFeedIds(vault.oracleDetailedInfo)
  return feeds.length > 0
}

const hasBorrowPriceFailure = (vault: Vault | undefined): boolean => {
  if (!vault) return false
  return (
    vault.liabilityPriceInfo?.queryFailure
    || vault.liabilityPriceInfo?.amountOutMid === undefined
    || vault.liabilityPriceInfo?.amountOutMid === null
  )
}

const hasCollateralPriceFailure = (bVault: Vault | undefined, collAddr: string | undefined): boolean => {
  if (!bVault || !collAddr) return false
  const collateralPrice = bVault.collateralPrices.find(
    p => p.asset.toLowerCase() === collAddr.toLowerCase(),
  )
  if (!collateralPrice) return true
  return (
    collateralPrice.queryFailure
    || collateralPrice.amountOutMid === undefined
    || collateralPrice.amountOutMid === null
  )
}

const needsRefresh = (vault: Vault | undefined): boolean => {
  return hasPythOracles(vault) || hasBorrowPriceFailure(vault)
}

const needsRefreshForCollateral = (bVault: Vault | undefined, collAddr: string | undefined): boolean => {
  return hasPythOracles(bVault) || hasCollateralPriceFailure(bVault, collAddr)
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
  const collAddr = current.collateral.address

  const borrowNeedsRefresh = needsRefresh(current.borrow) || needsRefreshForCollateral(current.borrow, collAddr)

  if (borrowNeedsRefresh && !refreshedVaultAddresses.has(borrowAddr)) {
    refreshedVaultAddresses.add(borrowAddr)
    const refreshedBorrow = await updateVault(current.borrow.address)
    pair.value = { ...current, borrow: refreshedBorrow } as AnyBorrowVaultPair
    current = pair.value
  }

  if ('liabilityPriceInfo' in current.collateral) {
    const collateralVaultTyped = current.collateral as Vault
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
    ? current.borrow.collateralLTVs.some(ltv => normalizeAddress(ltv.collateral) === supplyAddress)
    : false
  if (!multiply.multiplySupplyVault.value || !isSupplyAllowed) {
    multiply.initMultiplySupplyVault(current.collateral as Vault)
  }
  if (!current.collateral.verified) {
    modal.open(VaultUnverifiedDisclaimerModal, {
      isNotClosable: true,
      props: {
        onCancel: () => {
          router.replace('/')
        },
      },
    })
  }
  await updateBalance()
}, { immediate: true })

watch(address, () => {
  pendingSubAccount.value = null
  pendingSubAccountPromise = null
  updateBalance()
})

watch(formTab, () => {
  borrow.resetOnTabSwitch()
  multiply.resetOnTabSwitch()
})
</script>

<template>
  <div class="flex gap-32 max-w-[1000px] mx-auto">
    <div class="flex flex-col gap-16 w-full">
      <BaseBackButton class="laptop:!hidden" />
      <VaultForm
        title="Open borrow position"
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

          <VaultLabelsAndAssets
            v-if="collateralVault && borrowVault"
            :vault="collateralVault"
            :pair-vault="borrowVault"
            :assets="pairAssets as VaultAsset[]"
            size="large"
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
              maxable
              @input="borrow.onCollateralInput"
              @change-collateral="borrow.onChangeCollateral"
            />

            <!-- Pay with token selector -->
            <div
              v-if="borrow.enableSwapDeposit && collateralVault"
              class="flex items-center gap-8"
            >
              <span class="text-p3 text-content-tertiary">Pay with</span>
              <button
                type="button"
                class="flex items-center gap-6 bg-euler-dark-500 text-p3 font-semibold px-12 h-36 rounded-[40px] whitespace-nowrap"
                @click="borrow.openBorrowSwapTokenSelector"
              >
                <AssetAvatar
                  :asset="{ address: borrow.borrowSelectedAsset.value?.address || collateralVault.asset.address, symbol: borrow.borrowSelectedAsset.value?.symbol || collateralVault.asset.symbol }"
                  size="20"
                />
                {{ borrow.borrowSelectedAsset.value?.symbol || collateralVault.asset.symbol }}
                <SvgIcon
                  class="text-euler-dark-800 !w-16 !h-16"
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
                v-if="borrow.borrowSwapEstimatedCollateral.value"
                :loading="borrow.isBorrowSwapQuoteLoading.value"
              >
                <SummaryRow
                  label="Estimated collateral"
                  align-top
                >
                  <p class="text-p2">
                    ~{{ formatSmartAmount(borrow.borrowSwapEstimatedCollateral.value) }} {{ collateralVault.asset.symbol }}
                  </p>
                </SummaryRow>
                <SummaryRow label="Slippage tolerance">
                  <button
                    type="button"
                    class="flex items-center gap-6 text-p2"
                    @click="openSlippageSettings"
                  >
                    <span>{{ formatNumber(borrow.borrowSwapSlippage.value, 2, 0) }}%</span>
                    <SvgIcon
                      name="edit"
                      class="!w-16 !h-16 text-accent-600"
                    />
                  </button>
                </SummaryRow>
              </VaultFormInfoBlock>

              <UiToast
                v-if="borrow.borrowSwapQuoteError.value"
                title="Swap quote"
                variant="warning"
                :description="borrow.borrowSwapQuoteError.value"
                size="compact"
              />
            </template>

            <UiRange
              v-model="borrow.ltv.value"
              label="LTV"
              :step="0.1"
              :max="Number(pair.borrowLTV / 100n)"
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

            <UiToast
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="isPairFullyRestricted"
              title="Region restricted"
              description="This pair is not available in your region."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="!isGeoBlocked && !isPairFullyRestricted && isBorrowRestricted"
              title="Asset restricted"
              description="Borrowing this asset is not available in your region."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="!isGeoBlocked && !isPairFullyRestricted && !isBorrowRestricted && borrow.isBorrowSwapRestricted.value"
              title="Swap restricted"
              description="Swapping into this collateral vault is not available in your region. You can provide the vault's underlying asset directly."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-show="borrow.errorText.value"
              title="Error"
              variant="error"
              :description="borrow.errorText.value || ''"
              size="compact"
            />
            <UiToast
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
              <SummaryRow label="Net APY">
                <SummaryValue
                  :after="borrow.netAPY.value ? formatNumber(borrow.netAPY.value) : undefined"
                  suffix="%"
                  estimate-only
                />
              </SummaryRow>
              <SummaryRow label="Oracle price">
                <SummaryPriceValue
                  :value="!borrow.priceFixed.value.isZero() ? formatSmartAmount(borrow.borrowPriceInvert.invertValue(borrow.priceFixed.value.toUnsafeFloat())) : undefined"
                  :symbol="borrow.borrowPriceInvert.displaySymbol"
                  invertible
                  @invert="borrow.borrowPriceInvert.toggle"
                />
              </SummaryRow>
              <SummaryRow label="Liquidation price">
                <SummaryPriceValue
                  :value="borrow.borrowPriceInvert.invertValue(borrow.liquidationPrice.value) != null ? formatSmartAmount(borrow.borrowPriceInvert.invertValue(borrow.liquidationPrice.value)!) : undefined"
                  :symbol="borrow.borrowPriceInvert.displaySymbol"
                  invertible
                  @invert="borrow.borrowPriceInvert.toggle"
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
                  label="Long"
                  :asset="multiply.multiplyLongVault.value.asset"
                  :vault="(multiply.multiplyLongVault.value as Vault)"
                  :readonly="true"
                />

                <AssetInput
                  v-model="multiply.multiplyShortAmount.value"
                  :desc="multiply.multiplyShortProduct.name"
                  label="Short"
                  :asset="multiply.multiplyShortVault.value.asset"
                  :vault="multiply.multiplyShortVault.value"
                  :readonly="true"
                />

                <UiToast
                  v-if="isGeoBlocked"
                  title="Region restricted"
                  description="This operation is not available in your region. You can still repay existing debt."
                  variant="warning"
                  size="compact"
                />
                <UiToast
                  v-if="isPairFullyRestricted"
                  title="Region restricted"
                  description="This pair is restricted in your region."
                  variant="warning"
                  size="compact"
                />
                <UiToast
                  v-if="!isGeoBlocked && !isPairFullyRestricted && isMultiplyRestricted"
                  title="Asset restricted"
                  description="Multiply is not available for this pair in your region."
                  variant="warning"
                  size="compact"
                />
                <UiToast
                  v-show="multiply.multiplyErrorText.value"
                  title="Error"
                  variant="error"
                  :description="multiply.multiplyErrorText.value || ''"
                  size="compact"
                />
                <UiToast
                  v-if="multiply.multiplySimulationError.value"
                  title="Error"
                  variant="error"
                  :description="multiply.multiplySimulationError.value"
                  size="compact"
                />

                <UiToast
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
                  <SummaryRow label="ROE">
                    <SummaryValue
                      :after="multiply.multiplyRoeAfter.value !== null && multiply.multiplySwapReady.value ? formatNumber(multiply.multiplyRoeAfter.value) : (multiply.multiplyRoeBefore.value !== null ? formatNumber(multiply.multiplyRoeBefore.value) : undefined)"
                      suffix="%"
                      estimate-only
                    />
                  </SummaryRow>
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
                  <SummaryRow label="Liquidation price">
                    <SummaryPriceValue
                      :value="multiply.multiplyNextLiquidationPrice.value !== null && multiply.multiplySwapReady.value ? formatSmartAmount(multiply.multiplyPriceInvert.invertValue(multiply.multiplyNextLiquidationPrice.value)) : (multiply.multiplyPriceInvert.invertValue(multiply.multiplyCurrentLiquidationPrice.value) != null ? formatSmartAmount(multiply.multiplyPriceInvert.invertValue(multiply.multiplyCurrentLiquidationPrice.value)!) : undefined)"
                      :symbol="multiply.multiplyPriceInvert.displaySymbol"
                      estimate-only
                      invertible
                      @invert="multiply.multiplyPriceInvert.toggle"
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
                  <SummaryRow
                    label="Swap"
                    align-top
                  >
                    <p class="text-p2 text-right flex flex-col items-end">
                      <span>{{ multiply.multiplySwapSummary.value ? multiply.multiplySwapSummary.value.from : '-' }}</span>
                      <span
                        v-if="multiply.multiplySwapSummary.value"
                        class="text-content-tertiary text-p3"
                      >
                        {{ multiply.multiplySwapSummary.value.to }}
                      </span>
                    </p>
                  </SummaryRow>
                  <SummaryRow label="Price impact">
                    <p class="text-p2">
                      {{ multiply.multiplyPriceImpact.value !== null ? `${formatNumber(multiply.multiplyPriceImpact.value, 2, 2)}%` : '-' }}
                    </p>
                  </SummaryRow>
                  <SummaryRow label="Slippage tolerance">
                    <button
                      type="button"
                      class="flex items-center gap-6 text-p2"
                      @click="openSlippageSettings"
                    >
                      <span>{{ formatNumber(multiply.multiplySlippage.value, 2, 0) }}%</span>
                      <SvgIcon
                        name="edit"
                        class="!w-16 !h-16 text-accent-600"
                      />
                    </button>
                  </SummaryRow>
                  <SummaryRow label="Routed via">
                    <p class="text-p2 text-right">
                      {{ multiply.multiplyRoutedVia.value || '-' }}
                    </p>
                  </SummaryRow>
                </VaultFormInfoBlock>
              </div>
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
            :loading="borrow.isSubmitting.value || borrow.isPreparing.value"
          >
            {{ reviewBorrowLabel }}
          </VaultFormSubmit>
          <VaultFormSubmit
            v-else-if="formTab === 'multiply'"
            :disabled="reviewMultiplyDisabled"
            :loading="multiply.isMultiplySubmitting.value || multiply.isMultiplyPreparing.value"
          >
            {{ reviewMultiplyLabel }}
          </VaultFormSubmit>
        </template>
      </VaultForm>
    </div>
    <div
      v-if="pair"
      class="w-full min-w-0 mobile:hidden"
    >
      <div class="bg-surface border border-line-default rounded-6 shadow-sm">
        <UiTabs
          v-if="tabs.length"
          v-model="tab"
          class="mb-12 min-w-0"
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
            :vault="(pair.collateral as SecuritizeVault)"
            desktop-overview
          />
          <VaultOverview
            v-else-if="tab === 'collateral'"
            :vault="(pair.collateral as Vault)"
            desktop-overview
            @vault-click="(address: string) => router.push(`/lend/${address}`)"
          />
          <VaultOverview
            v-else-if="tab === 'multiply-collateral' && multiply.multiplySupplyVault.value"
            :vault="multiply.multiplySupplyVault.value"
            desktop-overview
            @vault-click="(address: string) => router.push(`/lend/${address}`)"
          />
          <VaultOverview
            v-else-if="tab === 'borrow'"
            :vault="pair.borrow"
            desktop-overview
            @vault-click="(address: string) => router.push(`/lend/${address}`)"
          />
        </Transition>
      </div>
    </div>
  </div>
</template>
