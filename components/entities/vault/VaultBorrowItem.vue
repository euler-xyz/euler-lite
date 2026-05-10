<script setup lang="ts">
import { getAddress } from 'viem'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { type AnyBorrowVaultPair, type Vault, getVaultUtilization, isCyclicalNoteVault } from '~/entities/vault'
import { getUtilisationWarning, getBorrowCapWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isVaultRecentlyAdded, isVaultKeyring, getEntitiesByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultBorrowApyModal, VaultMaxRoeModal, VaultNetApyPairModal, VaultSupplyApyModal } from '#components'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair }>()
const { enableEntityBranding } = useDeployConfig()
const { isVaultGovernorVerified } = useVaults()

const isAnyGovernorUnverified = computed(() => {
  const borrowUnverified = !isVaultGovernorVerified(pair.borrow)
  const collateralUnverified = 'governorAdmin' in pair.collateral
    ? !isVaultGovernorVerified(pair.collateral as Vault)
    : false
  return borrowUnverified || collateralUnverified
})

const entityDisplay = computed(() => {
  const borrowEntities = getEntitiesByVault(pair.borrow)
  // Collateral may be SecuritizeVault but getEntitiesByVault only needs governorAdmin
  const collateralEntities = 'governorAdmin' in pair.collateral
    ? getEntitiesByVault(pair.collateral as Vault)
    : []
  // Deduplicate by name
  const seen = new Set<string>()
  const all = [...collateralEntities, ...borrowEntities].filter((e) => {
    if (seen.has(e.name)) return false
    seen.add(e.name)
    return true
  })
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

const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo }
  = useIntrinsicApy()
const { getBorrowRewardApy, getSupplyRewardApy, getLoopingRewardApy, hasSupplyRewards, hasBorrowRewards, hasLoopingRewards, getBorrowRewardCampaigns, getSupplyRewardCampaigns, getLoopingRewardCampaigns } = useRewardsApy()
const modal = useModal()

const collateralProduct = useEulerProductOfVault(
  computed(() => pair.collateral.address),
)
const borrowProduct = useEulerProductOfVault(
  computed(() => pair.borrow.address),
)

const isAnyGovernanceLimited = computed(() =>
  (collateralProduct.isGovernanceLimited || borrowProduct.isGovernanceLimited) && !isAnyGovernorUnverified.value,
)

const isEscrowCollateral = computed(
  () =>
    'vaultCategory' in pair.collateral
    && pair.collateral.vaultCategory === 'escrow',
)

const isAnyUnverified = computed(() => {
  const collateralUnverified
    = 'verified' in pair.collateral && !pair.collateral.verified
  const borrowUnverified = 'verified' in pair.borrow && !pair.borrow.verified
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
const isCyclicalNote = computed(() => isCyclicalNoteVault(pair.borrow))

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
    : collateralProduct.name || pair.collateral.name
  const borrowName = borrowProduct.name || pair.borrow.name

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
  const interestRateInfo
    = 'interestRateInfo' in pair.collateral
      ? pair.collateral.interestRateInfo
      : null
  const baseApy = interestRateInfo
    ? nanoToValue(interestRateInfo.supplyAPY, 25)
    : 0
  return withIntrinsicSupplyApy(baseApy, pair.collateral.asset.address)
})
const borrowApy = computed(() =>
  withIntrinsicBorrowApy(
    nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25),
    pair.borrow.asset.address,
  ),
)
const supplyApyWithRewards = computed(
  () => supplyApy.value + supplyRewardsAPY.value,
)
const borrowApyWithRewards = computed(
  () => borrowApy.value - borrowRewardsAPY.value,
)
const maxMultiplier = computed(() => getMaxMultiplier(pair.borrowLTV))
const netApy = computed(
  () => supplyApyWithRewards.value - borrowApyWithRewards.value + loopingRewardsAPY.value,
)
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardsAPY.value),
)
const maxLTV = computed(() => formatNumber(nanoToValue(pair.borrowLTV, 2), 2))
const utilization = computed(() => getVaultUtilization(pair.borrow))
const utilisationWarning = computed(() => getUtilisationWarning(pair.borrow, 'borrow'))
const borrowCapInfo = computed(() => getBorrowCapWarning(pair.borrow))

const liquidityDisplay = ref('-')

watchEffect(async () => {
  const liquidity = pair.borrow.supply - pair.borrow.borrow
  const price = await formatAssetValue(liquidity, pair.borrow, 'off-chain')
  liquidityDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const onBorrowInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(VaultBorrowApyModal, {
    props: {
      borrowingAPY: nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25),
      intrinsicAPY: getIntrinsicApy(pair.borrow.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(pair.borrow.asset.address),
      campaigns: getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address),
    },
  })
}

const onSupplyInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  const baseSupply = 'interestRateInfo' in pair.collateral
    ? nanoToValue(pair.collateral.interestRateInfo.supplyAPY, 25)
    : 0
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: baseSupply,
      intrinsicAPY: getIntrinsicApy(pair.collateral.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(pair.collateral.asset.address),
      campaigns: getSupplyRewardCampaigns(pair.collateral.address),
    },
  })
}

const onNetApyInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  const baseSupply = 'interestRateInfo' in pair.collateral
    ? nanoToValue(pair.collateral.interestRateInfo.supplyAPY, 25)
    : 0
  const baseBorrow = nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25)
  modal.open(VaultNetApyPairModal, {
    props: {
      supplyAPY: baseSupply,
      borrowAPY: baseBorrow,
      intrinsicSupplyAPY: getIntrinsicApy(pair.collateral.asset.address),
      intrinsicBorrowAPY: getIntrinsicApy(pair.borrow.asset.address),
      supplyRewardAPY: supplyRewardsAPY.value || null,
      borrowRewardAPY: borrowRewardsAPY.value || null,
      loopingRewardAPY: loopingRewardsAPY.value || null,
      supplyCampaigns: getSupplyRewardCampaigns(pair.collateral.address),
      borrowCampaigns: getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address),
      loopingCampaigns: getLoopingRewardCampaigns(pair.borrow.address, pair.collateral.address),
    },
  })
}

const onMaxRoeInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(VaultMaxRoeModal, {
    props: {
      maxRoe: maxRoe.value,
      maxMultiplier: maxMultiplier.value,
      supplyAPY: supplyApyWithRewards.value,
      borrowAPY: borrowApyWithRewards.value,
      borrowLTV: nanoToValue(pair.borrowLTV, 2),
      borrowVaultAddress: pair.borrow.address,
      collateralAddress: pair.collateral.address,
    },
  })
}

const route = useRoute()

const linkPath = computed(() => ({
  path: `/borrow/${pair.collateral.address}/${pair.borrow.address}`,
  query: { network: route.query.network },
}))
</script>

<template>
  <NuxtLink
    :to="linkPath"
    class="grid gap-x-16 mobile:block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all"
    :class="[
      enableEntityBranding ? '' : 'grid-cols-6',
      (isGeoBlocked || isPairEffectivelyBlocked) ? 'opacity-50' : '',
    ]"
    :style="enableEntityBranding ? { gridTemplateColumns: 'repeat(7, 1fr)' } : undefined"
  >
    <!-- Header: contents on desktop (children become grid items), flex on mobile -->
    <div class="contents mobile:!flex mobile:py-16 mobile:px-16 mobile:pb-12 mobile:border-b mobile:border-line-subtle">
      <div
        :class="enableEntityBranding ? 'col-span-5' : 'col-span-4'"
        class="flex pl-16 py-16 pb-12 mobile:!p-0 mobile:flex-1 mobile:min-w-0 mobile:items-center"
      >
        <AssetAvatar
          :asset="[pair.collateral.asset, pair.borrow.asset]"
          size="40"
        />
        <div class="flex-grow ml-12">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-8">
            <VaultDisplayName
              :name="pairName"
              :is-unverified="isAnyUnverified"
            />
            <span
              v-if="isRecentlyAdded"
              class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5"
              title="Recently added vault"
            >
              <SvgIcon
                name="star"
                class="!w-14 !h-14"
              />
              Recently added
            </span>
            <KeyringBadge v-if="isKeyring" />
            <GovernanceLimitedBadge v-if="isAnyGovernanceLimited" />
            <CyclicalNoteBadge v-if="isCyclicalNote" />
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
          <div class="text-h5 text-content-primary">
            {{
              [pair.collateral.asset.symbol, pair.borrow.asset.symbol].join("/")
            }}
          </div>
        </div>
      </div>
      <div class="flex flex-col items-center justify-end py-16 pb-12 mobile:!flex mobile:items-end">
        <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center gap-4">
          Borrow APY
          <SvgIcon
            class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
            name="info-circle"
            @click="onBorrowInfoIconClick"
          />
        </div>
        <div class="text-p2 flex items-center text-accent-600 font-semibold">
          <SvgIcon
            v-if="hasBorrowApyRewards"
            class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
            name="sparks"
            @click="onBorrowInfoIconClick"
          />
          {{ formatNumber(borrowApyWithRewards) }}%
        </div>
        <div class="hidden mobile:!flex mobile:flex-col mobile:items-end mobile:mt-8">
          <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center gap-4">
            Max ROE
            <SvgIcon
              class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              @click="onMaxRoeInfoIconClick"
            />
          </div>
          <div class="text-p2 text-accent-600 font-semibold flex items-center">
            <SvgIcon
              v-if="hasAnyRewards"
              class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
              name="sparks"
              @click="onMaxRoeInfoIconClick"
            />
            {{ formatNumber(maxRoe, 2, 2) }}%
          </div>
        </div>
      </div>
      <div class="flex flex-col items-end pr-16 py-16 pb-12 mobile:!hidden">
        <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center gap-4">
          Max ROE
          <SvgIcon
            class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
            name="info-circle"
            @click="onMaxRoeInfoIconClick"
          />
        </div>
        <div class="text-p2 text-accent-600 font-semibold flex items-center">
          <SvgIcon
            v-if="hasAnyRewards"
            class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
            name="sparks"
            @click="onMaxRoeInfoIconClick"
          />
          {{ formatNumber(maxRoe, 2, 2) }}%
        </div>
      </div>
    </div>

    <!-- Border separator (desktop only) -->
    <div class="col-span-full border-b border-line-subtle mobile:!hidden" />

    <!-- Body stats: contents on desktop (children become grid items), flex on mobile -->
    <div class="contents mobile:!flex mobile:py-12 mobile:px-16 mobile:pb-12 mobile:justify-between mobile:border-b mobile:border-line-subtle">
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
          <span class="text-p2 text-content-primary truncate">{{ entityDisplay.name }}</span>
        </div>
        <div
          v-else
          class="text-p2 text-content-primary"
        >-</div>
      </div>
      <div
        class="py-12 pb-12 mobile:!p-0"
        :class="{ 'pl-16': !enableEntityBranding }"
      >
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Available liquidity
          <VaultWarningIcon
            :warning="borrowCapInfo"
            tooltip-placement="top-start"
          />
        </div>
        <div class="text-p2 text-content-primary">
          {{ liquidityDisplay }}
        </div>
      </div>
      <div class="py-12 pb-12 text-center mobile:!hidden">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-center gap-4">
          Supply APY
          <SvgIcon
            class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
            name="info-circle"
            @click="onSupplyInfoIconClick"
          />
        </div>
        <div class="text-p2 text-content-primary flex items-center justify-center">
          <SvgIcon
            v-if="hasSupplyRewards(pair.collateral.address)"
            class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
            name="sparks"
            @click="onSupplyInfoIconClick"
          />
          {{ formatNumber(supplyApyWithRewards, 2, 2) }}%
        </div>
      </div>
      <div class="py-12 pb-12 text-center mobile:!p-0">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center justify-center gap-4">
          Net APY
          <SvgIcon
            class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
            name="info-circle"
            @click="onNetApyInfoIconClick"
          />
        </div>
        <div class="text-p2 text-content-primary flex items-center justify-center">
          <SvgIcon
            v-if="hasAnyRewards"
            class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
            name="sparks"
            @click="onNetApyInfoIconClick"
          />
          {{ formatNumber(netApy, 2, 2) }}%
        </div>
      </div>
      <div class="py-12 pb-12 text-center mobile:!hidden">
        <div class="text-content-tertiary text-p3 mb-4">Max multiplier</div>
        <div class="text-p2 text-content-primary">
          {{ formatNumber(maxMultiplier, 2, 2) }}x
        </div>
      </div>
      <div class="py-12 pb-12 text-center mobile:!hidden">
        <div class="text-content-tertiary text-p3 mb-4">Max LTV</div>
        <div class="text-p2 text-content-primary">
          {{ compactNumber(maxLTV, 2, 2) }}%
        </div>
      </div>
      <div class="pr-16 py-12 pb-12 flex flex-col items-end mobile:!hidden">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Utilization
          <VaultWarningIcon :warning="utilisationWarning" />
        </div>
        <div class="flex gap-8 justify-end items-center text-right">
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
            <SvgIcon
              class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              @click="onSupplyInfoIconClick"
            />
          </div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <SvgIcon
            v-if="hasSupplyRewards(pair.collateral.address)"
            class="!w-20 !h-20 text-accent-500 cursor-pointer"
            name="sparks"
            @click="onSupplyInfoIconClick"
          />
          <div class="text-p2 text-content-primary">
            {{ formatNumber(supplyApyWithRewards, 2, 2) }}%
          </div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="flex-1">
          <div class="text-content-tertiary text-p3 flex items-center gap-4">
            Net APY
            <SvgIcon
              class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              @click="onNetApyInfoIconClick"
            />
          </div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <SvgIcon
            v-if="hasAnyRewards"
            class="!w-20 !h-20 text-accent-500 cursor-pointer"
            name="sparks"
            @click="onNetApyInfoIconClick"
          />
          <div class="text-p2 text-content-primary">
            {{ formatNumber(netApy, 2, 2) }}%
          </div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="flex-1">
          <div class="text-content-tertiary text-p3">Max multiplier</div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <div class="text-p2 text-content-primary">
            {{ formatNumber(maxMultiplier, 2, 2) }}x
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
