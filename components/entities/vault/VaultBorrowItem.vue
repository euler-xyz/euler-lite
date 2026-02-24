<script setup lang="ts">
import { getAddress } from 'viem'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { type AnyBorrowVaultPair, type Vault, getVaultUtilization } from '~/entities/vault'
import { getUtilisationWarning, getBorrowCapWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isVaultFeatured, getEntitiesByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultBorrowApyModal, VaultMaxRoeModal } from '#components'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair }>()
const { enableEntityBranding } = useDeployConfig()

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
const { getBorrowRewardApy, getSupplyRewardApy, hasSupplyRewards, hasBorrowRewards, getBorrowRewardCampaigns } = useRewardsApy()
const modal = useModal()

const collateralProduct = useEulerProductOfVault(
  computed(() => pair.collateral.address),
)
const borrowProduct = useEulerProductOfVault(
  computed(() => pair.borrow.address),
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

const isFeatured = computed(() => isVaultFeatured(pair.collateral.address) || isVaultFeatured(pair.borrow.address))

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
const hasRewards = computed(() =>
  hasSupplyRewards(pair.collateral.address) || hasBorrowRewards(pair.borrow.address, pair.collateral.address),
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
  () => supplyApyWithRewards.value - borrowApyWithRewards.value,
)
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value),
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
    },
  })
}

const linkPath = computed(
  () => `/borrow/${pair.collateral.address}/${pair.borrow.address}`,
)
</script>

<template>
  <NuxtLink
    :to="linkPath"
    class="grid items-center gap-x-16 py-16 px-20 mobile:block no-underline text-content-primary border-b border-line-default last:border-b-0 hover:bg-card-hover transition-all"
    :class="[
      enableEntityBranding ? 'grid-cols-[2fr_repeat(6,1fr)]' : 'grid-cols-[2fr_repeat(5,1fr)]',
      (isGeoBlocked || isPairEffectivelyBlocked) ? 'opacity-50' : '',
    ]"
  >
    <!-- Asset pair -->
    <div class="flex items-center mobile:mb-12">
      <SvgIcon
        name="star"
        class="!w-16 !h-16 text-accent-600 mr-4 shrink-0"
        :class="{ invisible: !isFeatured }"
        title="Featured Vault"
      />
      <AssetAvatar
        :asset="[pair.collateral.asset, pair.borrow.asset]"
        size="30"
      />
      <div class="flex-grow ml-12 min-w-0">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-8">
          <VaultDisplayName
            :name="pairName"
            :is-unverified="isAnyUnverified"
          />
          <span
            v-if="isGeoBlocked"
            class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
            title="This vault is not available in your region"
          >
            <SvgIcon
              name="warning"
              class="!w-14 !h-14"
            />
            Restricted
          </span>
          <span
            v-if="isGeoRestricted"
            class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
            title="Borrowing this asset is restricted in your region"
          >
            <SvgIcon
              name="warning"
              class="!w-14 !h-14"
            />
            Restricted
          </span>
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
          {{ [pair.collateral.asset.symbol, pair.borrow.asset.symbol].join("/") }}
        </div>
      </div>
    </div>

    <!-- Desktop stats (single row) -->
    <div class="flex items-center gap-4 mobile:!hidden">
      <div class="text-p2 flex items-center text-accent-600 font-semibold tabular-nums">
        <SvgIcon
          class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
          :class="{ invisible: !hasRewards }"
          name="sparks"
          @click="onBorrowInfoIconClick"
        />
        {{ formatNumber(borrowApyWithRewards) }}%
      </div>
      <SvgIcon
        class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
        name="info-circle"
        @click="onBorrowInfoIconClick"
      />
    </div>

    <div class="flex items-center gap-4 mobile:!hidden">
      <div class="text-p2 text-accent-600 font-semibold tabular-nums">
        {{ formatNumber(maxRoe, 2, 2) }}%
      </div>
      <SvgIcon
        class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
        name="info-circle"
        @click="onMaxRoeInfoIconClick"
      />
    </div>

    <div class="flex items-center gap-4 mobile:!hidden">
      <div class="text-p2 text-content-primary tabular-nums">
        {{ liquidityDisplay }}
      </div>
      <VaultWarningIcon
        :warning="borrowCapInfo"
        tooltip-placement="top-start"
      />
    </div>

    <div class="mobile:!hidden">
      <div class="text-p2 text-content-primary tabular-nums">
        {{ formatNumber(netApy, 2, 2) }}%
      </div>
    </div>

    <div
      v-if="enableEntityBranding"
      class="mobile:!hidden"
    >
      <div class="text-p2 text-content-primary tabular-nums">
        {{ compactNumber(maxLTV, 2, 2) }}%
      </div>
    </div>

    <div class="flex items-center justify-end gap-4 mobile:!hidden">
      <UiRadialProgress
        :value="utilization"
        :max="100"
      />
      <div class="text-p2 text-content-primary tabular-nums">
        {{ compactNumber(utilization, 2, 2) }}%
      </div>
      <VaultWarningIcon :warning="utilisationWarning" />
    </div>

    <!-- Mobile layout -->
    <div class="hidden mobile:!flex mobile:py-12 mobile:justify-between mobile:border-b mobile:border-line-subtle">
      <div>
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Borrow APY
          <SvgIcon
            class="!w-16 !h-16 text-content-muted"
            name="info-circle"
          />
        </div>
        <div class="text-p2 flex items-center text-accent-600 font-semibold tabular-nums">
          <SvgIcon
            v-if="hasRewards"
            class="!w-20 !h-20 text-accent-500 mr-4"
            name="sparks"
          />
          {{ formatNumber(borrowApyWithRewards) }}%
        </div>
      </div>
      <div class="flex flex-col items-end">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Max ROE
          <SvgIcon
            class="!w-16 !h-16 text-content-muted"
            name="info-circle"
          />
        </div>
        <div class="text-p2 text-accent-600 font-semibold tabular-nums">
          {{ formatNumber(maxRoe, 2, 2) }}%
        </div>
      </div>
    </div>

    <div class="hidden mobile:!flex mobile:flex-col gap-12 py-12 pb-16">
      <div
        v-if="enableEntityBranding"
        class="flex w-full justify-between"
      >
        <div class="text-content-tertiary text-p3">Risk manager</div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <template v-if="entityDisplay.name">
            <BaseAvatar
              class="icon--20"
              :label="entityDisplay.name"
              :src="entityDisplay.logos"
            />
            <span class="text-p2 text-content-primary truncate">{{ entityDisplay.name }}</span>
          </template>
          <div
            v-else
            class="text-p2 text-content-primary tabular-nums"
          >-</div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3 flex items-center gap-4">
          Available liquidity
          <VaultWarningIcon
            :warning="borrowCapInfo"
            tooltip-placement="top-start"
          />
        </div>
        <div class="text-p2 text-content-primary tabular-nums">
          {{ liquidityDisplay }}
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3">Net APY</div>
        <div class="text-p2 text-content-primary tabular-nums">
          {{ formatNumber(netApy, 2, 2) }}%
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3">Max LTV</div>
        <div class="text-p2 text-content-primary tabular-nums">
          {{ compactNumber(maxLTV, 2, 2) }}%
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3 flex items-center gap-4">
          Utilization
          <VaultWarningIcon :warning="utilisationWarning" />
        </div>
        <div class="flex gap-8 justify-end items-center">
          <UiRadialProgress
            :value="utilization"
            :max="100"
          />
          <div class="text-p2 text-content-primary tabular-nums">
            {{ compactNumber(utilization, 2, 2) }}%
          </div>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
