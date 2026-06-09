<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getUtilisationWarning, getBorrowCapWarning, getCollateralSupplyCapWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/utils/sdk-prices'
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
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair }>()
const { enableEntityBranding } = useDeployConfig()
const { isVaultGovernorVerified, isSecuritizeGovernorVerified } = useVaults()
const { getVaultCategory, isVerifiedVault } = useVaultRegistry()
const { areAssetsCorrelated, getAssetCorrelationLabel } = useTokenCorrelation()
const pairKey = computed(() => `${pair.collateral.address.toLowerCase()}:${pair.borrow.address.toLowerCase()}`)
const isPairCorrelated = computed(() =>
  areAssetsCorrelated(pair.collateral.asset, pair.borrow.asset),
)
const pairCorrelationCategory = computed(() =>
  getAssetCorrelationLabel(pair.collateral.asset.address, pair.collateral.asset.symbol),
)

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
const netApy = computed(
  () => supplyApyWithRewards.value - borrowApyWithRewards.value + loopingRewardsAPY.value,
)
const maxLTVPercent = computed(() => ltvToPercent(pair.ltv.borrowLTV))
const maxLTV = computed(() => formatNumber(maxLTVPercent.value, 2))
const maxMultiplier = computed(() => getMaxMultiplier(pair.ltv.borrowLTV))
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardsAPY.value),
)
const maxRoeClass = computed(() => maxRoe.value >= 0 ? 'text-accent-600' : 'text-error-500')
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
    borrowLTV: maxLTVPercent.value,
    borrowVaultAddress: pair.borrow.address,
    collateralAddress: pair.collateral.address,
  },
}))

const route = useRoute()

const linkPath = computed(() => ({
  path: `/borrow/${pair.collateral.address}/${pair.borrow.address}`,
  query: { network: route.query.network },
}))
</script>

<template>
  <NuxtLink
    :to="linkPath"
    class="group block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all relative overflow-hidden"
    data-id="vault-list-item"
    data-list="borrow-pair"
    :data-key="pairKey"
    :data-collateral-address="pair.collateral.address.toLowerCase()"
    :data-borrow-address="pair.borrow.address.toLowerCase()"
    :data-correlated="isPairCorrelated"
    :class="[
      (isGeoBlocked || isPairEffectivelyBlocked) ? 'opacity-50' : '',
    ]"
  >
    <div class="flex flex-col">
      <div
        class="flex items-start justify-between gap-16 py-16 px-16 pb-12 border-b border-line-subtle mobile:flex-wrap"
      >
        <div class="flex min-w-0 items-start gap-12">
          <AssetAvatar
            :asset="[pair.collateral.asset, pair.borrow.asset]"
            size="40"
          />
          <div class="min-w-0 flex-1">
            <div
              class="text-content-tertiary text-p3 mb-5 flex items-center gap-6 min-w-0"
              data-id="data-point"
              :data-key="pairKey"
              data-field="name"
              :data-value="pairName"
            >
              <span class="truncate">
                <VaultDisplayName
                  :name="pairName"
                  :is-unverified="isAnyUnverified"
                />
              </span>
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
              class="text-h5 text-content-primary flex flex-wrap items-center gap-8 min-w-0"
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
                class="shrink-0"
              />
              <CorrelatedPairBadge
                v-if="isPairCorrelated"
                compact
                title="This market uses assets from the same price-correlation category."
                :category="pairCorrelationCategory"
              />
            </div>
            <div
              v-if="enableEntityBranding"
              class="mt-7 flex items-center gap-6 text-p3 text-content-tertiary"
            >
              <span>Risk manager</span>
              <span class="text-content-muted">·</span>
              <div
                v-if="isAnyGovernorUnverified"
                class="inline-flex gap-5 items-center py-2 px-7 rounded-8 bg-error-100 text-error-500 text-p5"
              >
                <SvgIcon
                  name="warning"
                  class="!w-14 !h-14"
                />
                Unknown
              </div>
              <div
                v-else-if="entityDisplay.name"
                class="min-w-0 inline-flex items-center gap-5"
                :class="{ 'opacity-20': isAnyGovernanceLimited }"
              >
                <BaseAvatar
                  class="icon--16 shrink-0"
                  :label="entityDisplay.name"
                  :src="entityDisplay.logos"
                />
                <span
                  class="truncate"
                  data-id="data-point"
                  :data-key="pairKey"
                  data-field="risk-manager"
                  :data-value="entityDisplay.name"
                >{{ entityDisplay.name }}</span>
              </div>
              <span
                v-else
                class="text-content-primary"
              >-</span>
            </div>
          </div>
        </div>

        <div
          class="grid shrink-0 gap-18 text-right mobile:w-full mobile:text-left"
          :class="isPairCorrelated ? 'grid-cols-[112px_108px_112px] mobile:grid-cols-3 mobile:gap-12' : 'grid-cols-[112px] mobile:grid-cols-1'"
        >
          <div class="flex flex-col items-end mobile:items-start">
            <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-end gap-4 mobile:justify-start">
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
              class="text-p2 flex items-center justify-end text-accent-600 font-semibold mobile:justify-start"
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

          <div
            v-if="isPairCorrelated"
            class="flex flex-col items-end mobile:items-start"
          >
            <div class="text-content-tertiary text-p3 mb-4">
              Multiplier
            </div>
            <div
              class="text-p2 text-content-primary font-semibold tabular-nums"
              data-id="data-point"
              :data-key="pairKey"
              data-field="max-multiplier"
              :data-value="maxMultiplier"
            >
              {{ formatNumber(maxMultiplier, 2, 2) }}x
            </div>
          </div>

          <div
            v-if="isPairCorrelated"
            class="flex flex-col items-end mobile:items-start"
          >
            <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-end gap-4 mobile:justify-start">
              Max ROE
              <UiModalPreviewTrigger
                :component="VaultMaxRoeModal"
                :modal-data="maxRoeModalData"
                aria-label="Show max ROE breakdown"
              >
                <SvgIcon
                  class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                  name="info-circle"
                  data-modal-trigger="max-roe"
                />
              </UiModalPreviewTrigger>
            </div>
            <div
              class="text-p2 flex items-center justify-end font-semibold tabular-nums mobile:justify-start"
              :class="maxRoeClass"
              data-id="data-point"
              :data-key="pairKey"
              data-field="max-roe"
              :data-value="maxRoe"
            >
              <UiModalPreviewTrigger
                v-if="hasAnyRewards"
                :component="VaultMaxRoeModal"
                :modal-data="maxRoeModalData"
                aria-label="Show max ROE rewards breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                  name="sparks"
                  data-modal-trigger="max-roe"
                />
              </UiModalPreviewTrigger>
              {{ formatNumber(maxRoe) }}%
            </div>
          </div>
        </div>
      </div>

      <div
        class="grid grid-cols-5 gap-x-16 gap-y-12 py-12 px-16 pb-12 mobile:grid-cols-2 mobile:gap-y-14"
      >
        <div class="min-w-0">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
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

        <div class="min-w-0 flex flex-col items-center text-center mobile:items-start mobile:text-left">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-center gap-4 mobile:justify-start">
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
            class="text-p2 text-content-primary flex items-center justify-center mobile:justify-start"
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

        <div class="min-w-0 flex flex-col items-center text-center mobile:items-start mobile:text-left">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-center gap-4 mobile:justify-start">
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
            class="text-p2 text-content-primary flex items-center justify-center mobile:justify-start"
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

        <div class="min-w-0 flex flex-col items-center text-center mobile:items-start mobile:text-left">
          <div class="text-content-tertiary text-p3 mb-4">
            Max LTV
          </div>
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

        <div class="min-w-0 flex flex-col items-end text-right mobile:items-start mobile:text-left">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-end gap-4 mobile:justify-start">
            Utilization
            <VaultWarningIcon :warning="utilisationWarning" />
          </div>
          <div class="flex gap-8 justify-end items-center mobile:justify-start">
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
  </NuxtLink>
</template>
