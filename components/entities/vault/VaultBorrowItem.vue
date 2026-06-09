<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getUtilisationWarning, getBorrowCapWarning, getCollateralSupplyCapWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/utils/sdk-prices'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { withVaultIntrinsicApy, getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { getVaultAvailableLiquidity, getVaultUtilization } from '~/utils/vault-display'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isVaultGovernanceLimited, isVaultRecentlyAdded, isVaultKeyring, isVaultCyclicalNote, getUniqueEntitiesByVaults } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { VaultBorrowApyModal, VaultMaxRoeModal, VaultNetApyPairModal, VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import { isSecuritizeBorrowPair, type AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getAddress } from 'viem'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { areTokenAddressesCorrelatedByTags } from '~/utils/token-categories'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair }>()
const { enableEntityBranding } = useDeployConfig()
const { isVaultGovernorVerified, isSecuritizeGovernorVerified } = useVaults()
const { getVaultCategory, isVerifiedVault } = useVaultRegistry()
const { getTokenCategoryTags } = useTokenList()
const pairKey = computed(() => `${pair.collateral.address.toLowerCase()}:${pair.borrow.address.toLowerCase()}`)

const isAnyGovernorUnverified = computed(() => {
  const borrowUnverified = !isVaultGovernorVerified(pair.borrow)
  const collateralUnverified = isSecuritizeBorrowPair(pair)
    ? !isSecuritizeGovernorVerified(pair.collateral)
    : !isVaultGovernorVerified(pair.collateral)
  return borrowUnverified || collateralUnverified
})

const entityDisplay = computed(() => {
  const all = getUniqueEntitiesByVaults([pair.collateral, pair.borrow])
  if (all.length === 0) return { name: '', logos: [] }
  const name = all.length === 1
    ? all[0].name
    : all.length === 2
      ? `${all[0].name} & ${all[1].name}`
      : `${all[0].name} & others`
  return {
    name,
    logos: all.map(e => getEulerLabelEntityLogo(e.logo)),
  }
})

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getBorrowRewardApy, getSupplyRewardApy, getLoopingRewardApy, hasSupplyRewards, hasBorrowRewards, hasLoopingRewards, getBorrowRewardCampaigns, getSupplyRewardCampaigns, getLoopingRewardCampaigns } = useRewardsApy()
const collateralProduct = useEulerProductOfVault(
  computed(() => pair.collateral.address),
)
const borrowProduct = useEulerProductOfVault(
  computed(() => pair.borrow.address),
)

const isAnyGovernanceLimited = computed(() =>
  (isVaultGovernanceLimited(pair.collateral.address) || isVaultGovernanceLimited(pair.borrow.address)) && !isAnyGovernorUnverified.value,
)

const isEscrowCollateral = computed(
  () => getVaultCategory(pair.collateral.address) === 'escrow',
)

const isAnyUnverified = computed(() => {
  const collateralUnverified = !isVerifiedVault(pair.collateral.address)
  const borrowUnverified = !isVerifiedVault(pair.borrow.address)
  return collateralUnverified || borrowUnverified
})

const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(pair.collateral.address, pair.borrow.address))

const isGeoRestricted = computed(() => {
  if (isGeoBlocked.value) return false
  return isVaultRestrictedByCountry(pair.borrow.address)
})

const isPairEffectivelyBlocked = computed(() => {
  if (isGeoBlocked.value) return false
  return isVaultRestrictedByCountry(pair.borrow.address)
    && isVaultRestrictedByCountry(pair.collateral.address)
})

const isRecentlyAdded = computed(() => isVaultRecentlyAdded(pair.collateral.address) || isVaultRecentlyAdded(pair.borrow.address))
const isKeyring = computed(() => isVaultKeyring(pair.collateral.address) || isVaultKeyring(pair.borrow.address))
const isCyclicalNote = computed(() => isVaultCyclicalNote(pair.borrow.address))

const isAnyDeprecated = computed(() => {
  const collateralAddr = getAddress(pair.collateral.address)
  const borrowAddr = getAddress(pair.borrow.address)
  const collateralDeprecated = collateralProduct.deprecatedVaults?.includes(collateralAddr) ?? false
  const borrowDeprecated = borrowProduct.deprecatedVaults?.includes(borrowAddr) ?? false
  return collateralDeprecated || borrowDeprecated
})

const pairName = computed(() => {
  // Handle escrow collateral specially
  const collateralName = isEscrowCollateral.value
    ? 'Escrowed collateral'
    : collateralProduct.name || pair.collateral.shares.name
  const borrowName = borrowProduct.name || pair.borrow.shares.name

  if (collateralName === borrowName) {
    return collateralName
  }
  return `${collateralName}/${borrowName}`
})
const borrowRewardsAPY = computed(() =>
  getBorrowRewardApy(pair.borrow.address, pair.collateral.address),
)
const supplyRewardsAPY = computed(() =>
  getSupplyRewardApy(pair.collateral.address),
)
const loopingRewardsAPY = computed(() =>
  getLoopingRewardApy(pair.borrow.address, pair.collateral.address),
)
const hasBorrowApyRewards = computed(() =>
  hasBorrowRewards(pair.borrow.address, pair.collateral.address),
)
const hasAnyRewards = computed(() =>
  hasSupplyRewards(pair.collateral.address) || hasBorrowApyRewards.value || hasLoopingRewards(pair.borrow.address, pair.collateral.address),
)
const supplyApy = computed(() => {
  const baseApy = getVaultSupplyApy(pair.collateral)
  return withVaultIntrinsicApy(baseApy, pair.collateral, enableIntrinsicApy.value)
})
const borrowApy = computed(() =>
  withVaultIntrinsicApy(
    getVaultBorrowApy(pair.borrow),
    pair.borrow,
    enableIntrinsicApy.value,
  ),
)
const supplyApyWithRewards = computed(
  () => supplyApy.value + supplyRewardsAPY.value,
)
const borrowApyWithRewards = computed(
  () => borrowApy.value - borrowRewardsAPY.value,
)
const maxMultiplier = computed(() => getMaxMultiplier(pair.ltv.borrowLTV))
const netApy = computed(
  () => supplyApyWithRewards.value - borrowApyWithRewards.value + loopingRewardsAPY.value,
)
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardsAPY.value),
)
const showMaxRoe = computed(() =>
  areTokenAddressesCorrelatedByTags(
    pair.collateral.asset.address,
    pair.borrow.asset.address,
    getTokenCategoryTags,
  ),
)
const maxLTV = computed(() => formatNumber(ltvToPercent(pair.ltv.borrowLTV), 2))
const utilization = computed(() => getVaultUtilization(pair.borrow))
const utilisationWarning = computed(() => getUtilisationWarning(pair.borrow, 'borrow'))
const borrowCapInfo = computed(() => getBorrowCapWarning(pair.borrow))
const supplyCapInfo = computed(() => getCollateralSupplyCapWarning(pair.collateral))

const liquidityDisplay = ref('-')

watchEffect(async () => {
  const liquidity = getVaultAvailableLiquidity(pair.borrow)
  const price = await formatAssetValue(liquidity, pair.borrow, 'on-chain')
  liquidityDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const borrowApyModalData = computed(() => ({
  props: {
    borrowingAPY: getVaultBorrowApy(pair.borrow),
    intrinsicAPY: getVaultIntrinsicApy(pair.borrow, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(pair.borrow, enableIntrinsicApy.value),
    campaigns: getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address),
    rewardVaultAddress: pair.borrow.address,
  },
}))

const supplyApyModalData = computed(() => {
  const baseSupply = 'interestRateInfo' in pair.collateral
    ? getVaultSupplyApy(pair.collateral as EVault)
    : 0
  return {
    props: {
      lendingAPY: baseSupply,
      intrinsicAPY: getVaultIntrinsicApy(pair.collateral, enableIntrinsicApy.value),
      intrinsicApyInfo: getVaultIntrinsicApyInfo(pair.collateral, enableIntrinsicApy.value),
      campaigns: getSupplyRewardCampaigns(pair.collateral.address),
      rewardVaultAddress: pair.collateral.address,
    },
  }
})

const netApyModalData = computed(() => ({
  props: {
    supplyAPY: getVaultSupplyApy(pair.collateral),
    borrowAPY: getVaultBorrowApy(pair.borrow),
    intrinsicSupplyAPY: getVaultIntrinsicApy(pair.collateral, enableIntrinsicApy.value),
    intrinsicBorrowAPY: getVaultIntrinsicApy(pair.borrow, enableIntrinsicApy.value),
    supplyRewardAPY: supplyRewardsAPY.value || null,
    borrowRewardAPY: borrowRewardsAPY.value || null,
    loopingRewardAPY: loopingRewardsAPY.value || null,
    supplyCampaigns: getSupplyRewardCampaigns(pair.collateral.address),
    borrowCampaigns: getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address),
    loopingCampaigns: getLoopingRewardCampaigns(pair.borrow.address, pair.collateral.address),
  },
}))

const maxRoeModalData = computed(() => ({
  props: {
    maxRoe: maxRoe.value,
    maxMultiplier: maxMultiplier.value,
    supplyAPY: supplyApyWithRewards.value,
    borrowAPY: borrowApyWithRewards.value,
    borrowLTV: ltvToPercent(pair.ltv.borrowLTV),
    borrowVaultAddress: pair.borrow.address,
    collateralAddress: pair.collateral.address,
  },
}))

const headlineMetricLabel = computed(() => showMaxRoe.value ? 'Max ROE' : 'Net APY')
const headlineMetricValue = computed(() => showMaxRoe.value ? maxRoe.value : netApy.value)
const headlineMetricModalComponent = computed(() => showMaxRoe.value ? VaultMaxRoeModal : VaultNetApyPairModal)
const headlineMetricModalData = computed(() => showMaxRoe.value ? maxRoeModalData.value : netApyModalData.value)
const headlineMetricField = computed(() => showMaxRoe.value ? 'max-roe' : 'fallback-net-apy')
const headlineMetricTrigger = computed(() => showMaxRoe.value ? 'max-roe' : 'net-apy')
const headlineMetricAriaLabel = computed(() => showMaxRoe.value ? 'Show max ROE breakdown' : 'Show net APY breakdown')
const headlineMetricRewardsAriaLabel = computed(() => showMaxRoe.value ? 'Show max ROE rewards breakdown' : 'Show net APY rewards breakdown')

const route = useRoute()

const linkPath = computed(() => ({
  path: `/borrow/${pair.collateral.address}/${pair.borrow.address}`,
  query: {
    network: route.query.network,
    ...(showMaxRoe.value ? { tab: 'multiply' } : {}),
  },
}))
</script>

<template>
  <NuxtLink
    :to="linkPath"
    class="grid gap-x-16 mobile:block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all"
    data-id="vault-list-item"
    data-list="borrow-pair"
    :data-key="pairKey"
    :data-collateral-address="pair.collateral.address.toLowerCase()"
    :data-borrow-address="pair.borrow.address.toLowerCase()"
    :data-correlated="showMaxRoe"
    :class="[
      enableEntityBranding ? '' : 'grid-cols-6',
      (isGeoBlocked || isPairEffectivelyBlocked) ? 'opacity-50' : '',
    ]"
    :style="enableEntityBranding ? { gridTemplateColumns: 'repeat(7, 1fr)' } : undefined"
  >
    <!-- Header: contents on desktop (children become grid items), flex on mobile -->
    <div class="contents mobile:!flex mobile:py-16 mobile:px-16 mobile:pb-12 mobile:border-b mobile:border-line-subtle">
      <div
        :class="enableEntityBranding ? 'col-span-4' : 'col-span-3'"
        class="flex pl-16 py-16 pb-12 mobile:!p-0 mobile:flex-1 mobile:min-w-0 mobile:items-center"
      >
        <AssetAvatar
          :asset="[pair.collateral.asset, pair.borrow.asset]"
          size="40"
        />
        <div class="flex-grow ml-12">
          <div
            class="text-content-tertiary text-p3 mb-4 flex items-center gap-8"
            data-id="data-point"
            :data-key="pairKey"
            data-field="name"
            :data-value="pairName"
          >
            <VaultDisplayName
              :name="pairName"
              :is-unverified="isAnyUnverified"
            />
            <RecentlyAddedBadge
              v-if="isRecentlyAdded"
              class="mobile:hidden"
            />
            <KeyringBadge v-if="isKeyring && !isAnyGovernorUnverified" />
            <GovernanceLimitedBadge v-if="isAnyGovernanceLimited" />
            <CyclicalNoteBadge v-if="isCyclicalNote && !isAnyGovernorUnverified" />
            <RestrictedBadge
              v-if="isGeoBlocked"
              variant="blocked"
            />
            <RestrictedBadge
              v-else-if="isGeoRestricted"
              variant="restricted"
            />
            <span
              v-if="isAnyDeprecated"
              class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
            >
              <SvgIcon
                name="warning"
                class="!w-14 !h-14"
              />
              Deprecated
            </span>
          </div>
          <div
            class="text-h5 text-content-primary flex items-center gap-8"
            data-id="data-point"
            :data-key="pairKey"
            data-field="asset-symbols"
            :data-value="[pair.collateral.asset.symbol, pair.borrow.asset.symbol].join('/')"
          >
            <span>
              {{
                [pair.collateral.asset.symbol, pair.borrow.asset.symbol].join("/")
              }}
            </span>
            <RecentlyAddedBadge
              v-if="isRecentlyAdded"
              class="hidden mobile:inline-flex shrink-0"
            />
            <CorrelatedPairBadge
              v-if="showMaxRoe"
              compact
              title="This pair shares a trusted price-correlation category, so Max ROE is shown."
            />
          </div>
        </div>
      </div>
      <div class="col-span-3 grid grid-cols-[repeat(3,112px)] justify-end gap-x-24 pr-16 py-16 pb-12 mobile:!flex mobile:flex-col mobile:items-end mobile:gap-8 mobile:!p-0">
        <div class="flex flex-col items-end">
          <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center justify-end gap-4">
            Borrow APY
            <UiModalPreviewTrigger
              :component="VaultBorrowApyModal"
              :modal-data="borrowApyModalData"
              aria-label="Show borrow APY breakdown"
            >
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
                data-modal-trigger="borrow-apy"
              />
            </UiModalPreviewTrigger>
          </div>
          <div
            class="text-p2 flex items-center justify-end text-accent-600 font-semibold"
            data-id="data-point"
            :data-key="pairKey"
            data-field="borrow-apy"
            :data-value="borrowApyWithRewards"
          >
            <UiModalPreviewTrigger
              v-if="hasBorrowApyRewards"
              :component="VaultBorrowApyModal"
              :modal-data="borrowApyModalData"
              aria-label="Show borrow APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                name="sparks"
                data-modal-trigger="borrow-apy"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(borrowApyWithRewards) }}%
          </div>
        </div>
        <div class="flex flex-col items-end">
          <div class="text-content-tertiary text-p3 mb-4 text-right">
            Max multiplier
          </div>
          <div
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="pairKey"
            data-field="max-multiplier"
            :data-value="maxMultiplier"
          >
            {{ formatNumber(maxMultiplier, 2, 2) }}x
          </div>
        </div>
        <div class="flex flex-col items-end">
          <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center justify-end gap-4">
            {{ headlineMetricLabel }}
            <UiModalPreviewTrigger
              :component="headlineMetricModalComponent"
              :modal-data="headlineMetricModalData"
              :aria-label="headlineMetricAriaLabel"
            >
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
                :data-modal-trigger="headlineMetricTrigger"
              />
            </UiModalPreviewTrigger>
          </div>
          <div
            class="text-p2 text-accent-600 font-semibold flex items-center justify-end"
            data-id="data-point"
            :data-key="pairKey"
            :data-field="headlineMetricField"
            :data-value="headlineMetricValue"
          >
            <UiModalPreviewTrigger
              v-if="hasAnyRewards"
              :component="headlineMetricModalComponent"
              :modal-data="headlineMetricModalData"
              :aria-label="headlineMetricRewardsAriaLabel"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                name="sparks"
                :data-modal-trigger="headlineMetricTrigger"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(headlineMetricValue, 2, 2) }}%
          </div>
        </div>
      </div>
    </div>

    <!-- Border separator (desktop only) -->
    <div class="col-span-full border-b border-line-subtle mobile:!hidden" />

    <!-- Body stats: contents on desktop (children become grid items), flex on mobile -->
    <div class="col-span-full flex items-start mobile:!flex mobile:gap-0 mobile:py-12 mobile:px-16 mobile:pb-12 mobile:justify-between mobile:border-b mobile:border-line-subtle">
      <div
        v-if="enableEntityBranding"
        class="pl-16 py-12 pb-12 mobile:!hidden"
      >
        <div class="text-content-tertiary text-p3 mb-4">Risk manager</div>
        <div
          v-if="isAnyGovernorUnverified"
          class="flex gap-8 items-center py-4 px-8 rounded-8 bg-error-100 text-error-500 text-p2 w-fit"
        >
          <SvgIcon
            name="warning"
            class="!w-16 !h-16"
          />
          Unknown
        </div>
        <div
          v-else-if="entityDisplay.name"
          class="flex items-center gap-6"
          :class="{ 'opacity-20': isAnyGovernanceLimited }"
        >
          <BaseAvatar
            class="icon--20"
            :label="entityDisplay.name"
            :src="entityDisplay.logos"
          />
          <span
            class="text-p2 text-content-primary truncate"
            data-id="data-point"
            :data-key="pairKey"
            data-field="risk-manager"
            :data-value="entityDisplay.name"
          >{{ entityDisplay.name }}</span>
        </div>
        <div
          v-else
          class="text-p2 text-content-primary"
        >-</div>
      </div>
      <div class="ml-auto grid grid-cols-[140px_repeat(4,112px)] justify-end gap-x-20 pr-16 mobile:contents">
        <div
          class="py-12 pb-12 text-right mobile:!p-0"
          :class="{ 'pl-16': !enableEntityBranding }"
        >
          <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-end gap-4 whitespace-nowrap">
            Available liquidity
            <VaultWarningIcon
              :warning="[borrowCapInfo, supplyCapInfo]"
              tooltip-placement="top-start"
            />
          </div>
          <div
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="pairKey"
            data-field="available-liquidity"
            :data-value="liquidityDisplay"
          >
            {{ liquidityDisplay }}
          </div>
        </div>
        <div class="py-12 pb-12 text-right mobile:!hidden">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-end gap-4">
            Supply APY
            <UiModalPreviewTrigger
              :component="VaultSupplyApyModal"
              :modal-data="supplyApyModalData"
              aria-label="Show supply APY breakdown"
            >
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
                data-modal-trigger="supply-apy"
              />
            </UiModalPreviewTrigger>
          </div>
          <div
            class="text-p2 text-content-primary flex items-center justify-end"
            data-id="data-point"
            :data-key="pairKey"
            data-field="supply-apy"
            :data-value="supplyApyWithRewards"
          >
            <VaultPoints
              class="mr-4"
              :vault="pair.collateral"
            />
            <UiModalPreviewTrigger
              v-if="hasSupplyRewards(pair.collateral.address)"
              :component="VaultSupplyApyModal"
              :modal-data="supplyApyModalData"
              aria-label="Show supply APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                name="sparks"
                data-modal-trigger="supply-apy"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(supplyApyWithRewards, 2, 2) }}%
          </div>
        </div>
        <div class="py-12 pb-12 text-right mobile:!p-0">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-end gap-4">
            Net APY
            <UiModalPreviewTrigger
              :component="VaultNetApyPairModal"
              :modal-data="netApyModalData"
              aria-label="Show net APY breakdown"
            >
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
                data-modal-trigger="net-apy"
              />
            </UiModalPreviewTrigger>
          </div>
          <div
            class="text-p2 text-content-primary flex items-center justify-end"
            data-id="data-point"
            :data-key="pairKey"
            data-field="net-apy"
            :data-value="netApy"
          >
            <UiModalPreviewTrigger
              v-if="hasAnyRewards"
              :component="VaultNetApyPairModal"
              :modal-data="netApyModalData"
              aria-label="Show net APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                name="sparks"
                data-modal-trigger="net-apy"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(netApy, 2, 2) }}%
          </div>
        </div>
        <div class="py-12 pb-12 text-right mobile:!hidden">
          <div class="text-content-tertiary text-p3 mb-4">Max LTV</div>
          <div
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="pairKey"
            data-field="max-ltv"
            :data-value="maxLTV"
          >
            {{ compactNumber(maxLTV, 2, 2) }}%
          </div>
        </div>
        <div class="py-12 pb-12 flex flex-col items-end mobile:!hidden">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-end gap-4">
            Utilization
            <VaultWarningIcon :warning="utilisationWarning" />
          </div>
          <div class="flex gap-8 justify-end items-center text-right">
            <UiRadialProgress
              :value="utilization"
              :max="100"
            />
            <div
              class="text-p2 text-content-primary"
              data-id="data-point"
              :data-key="pairKey"
              data-field="utilization"
              :data-value="utilization"
            >
              {{ compactNumber(utilization, 2, 2) }}%
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Mobile expanded stats -->
    <div class="hidden mobile:flex mobile:flex-col gap-12 py-12 px-16 pb-16">
      <div
        v-if="enableEntityBranding"
        class="flex w-full justify-between"
      >
        <div class="flex-1">
          <div class="text-content-tertiary text-p3">Risk manager</div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <div
            v-if="isAnyGovernorUnverified"
            class="flex gap-8 items-center py-4 px-8 rounded-8 bg-error-100 text-error-500 text-p2 w-fit"
          >
            <SvgIcon
              name="warning"
              class="!w-16 !h-16"
            />
            Unknown
          </div>
          <div
            v-else-if="entityDisplay.name"
            class="flex items-center gap-8"
            :class="{ 'opacity-20': isAnyGovernanceLimited }"
          >
            <BaseAvatar
              class="icon--20"
              :label="entityDisplay.name"
              :src="entityDisplay.logos"
            />
            <span class="text-p2 text-content-primary truncate">{{ entityDisplay.name }}</span>
          </div>
          <div
            v-else
            class="text-p2 text-content-primary"
          >-</div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="flex-1">
          <div class="text-content-tertiary text-p3">Max LTV</div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <div class="text-p2 text-content-primary">
            {{ compactNumber(maxLTV, 2, 2) }}%
          </div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="flex-1">
          <div class="text-content-tertiary text-p3 flex items-center gap-4">
            Supply APY
            <UiModalPreviewTrigger
              :component="VaultSupplyApyModal"
              :modal-data="supplyApyModalData"
              aria-label="Show supply APY breakdown"
            >
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
                data-modal-trigger="supply-apy"
              />
            </UiModalPreviewTrigger>
          </div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <VaultPoints :vault="pair.collateral" />
          <UiModalPreviewTrigger
            v-if="hasSupplyRewards(pair.collateral.address)"
            :component="VaultSupplyApyModal"
            :modal-data="supplyApyModalData"
            aria-label="Show supply APY rewards breakdown"
          >
            <SvgIcon
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
              data-modal-trigger="supply-apy"
            />
          </UiModalPreviewTrigger>
          <div class="text-p2 text-content-primary">
            {{ formatNumber(supplyApyWithRewards, 2, 2) }}%
          </div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="flex-1">
          <div class="text-content-tertiary text-p3 flex items-center gap-4">
            Net APY
            <UiModalPreviewTrigger
              :component="VaultNetApyPairModal"
              :modal-data="netApyModalData"
              aria-label="Show net APY breakdown"
            >
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
                data-modal-trigger="net-apy"
              />
            </UiModalPreviewTrigger>
          </div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <UiModalPreviewTrigger
            v-if="hasAnyRewards"
            :component="VaultNetApyPairModal"
            :modal-data="netApyModalData"
            aria-label="Show net APY rewards breakdown"
          >
            <SvgIcon
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
              data-modal-trigger="net-apy"
            />
          </UiModalPreviewTrigger>
          <div class="text-p2 text-content-primary">
            {{ formatNumber(netApy, 2, 2) }}%
          </div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="flex-1">
          <div class="text-content-tertiary text-p3 flex items-center gap-4">
            Utilization
            <VaultWarningIcon :warning="utilisationWarning" />
          </div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <UiRadialProgress
            :value="utilization"
            :max="100"
          />
          <div class="text-p2 text-content-primary">
            {{ compactNumber(utilization, 2, 2) }}%
          </div>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
