<script setup lang="ts">
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import type { Component } from 'vue'

import { formatAssetValue } from '~/utils/sdk-prices'
import { useEulerEntitiesOfVault, useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getProductByVault, getProductKeyByVault, isVaultGovernanceLimited } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { autoLink } from '~/utils/autoLink'
import { formatMarketAvailability } from '~/utils/vault-display'
import { isVaultBorrowable } from '~/utils/vault/classification'
import type { VaultTypeBadge } from '~/composables/useVaultTypeBadges'
import { AccessControlBadge, CyclicalNoteBadge, GovernanceLimitedBadge, KeyringBadge } from '#components'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'
import { resolveVaultExposureDisplay, type ExposureValueState, type VaultExposureDisplay } from '~/utils/vault/exposure-display'

const { vault, defaultOpen = true } = defineProps<{ vault: EVault, defaultOpen?: boolean }>()
const emit = defineEmits<{
  'market-click': []
}>()
const route = useRoute()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { isVaultGovernorVerified } = useVaults()
const { get: registryGet } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
  isOpenInterestEnabled,
} = useCollateralOpenInterest()

type VaultPropertyBadge = Extract<VaultTypeBadge, 'private' | 'accessControl' | 'governanceLimited' | 'cyclicalNote'>

const vaultAddress = computed(() => getAddress(vault.address))
const vaultRef = computed(() => vault)
const product = useEulerProductOfVault(vaultAddress)
const entities = useEulerEntitiesOfVault(vault)
const { badges, governanceType } = useVaultTypeBadges(vaultRef)
const marketProductKey = computed(() => getProductKeyByVault(vault.address))
const marketProductName = computed(() => getProductByVault(vault.address).name)
const description = computed(() => {
  return product.vaultOverrides?.[vaultAddress.value]?.description ?? product.description
})

const isDeprecated = computed(() => {
  return product.deprecatedVaults?.includes(vaultAddress.value) ?? false
})
const deprecationReason = computed(() => isDeprecated.value ? product.deprecationReason || '' : '')
const isRestricted = computed(() => isVaultBlockedByCountry(vault.address))
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault))
const isGovernanceLimited = computed(() => isVaultGovernanceLimited(vault.address) && isGovernorVerified.value)

// Count how many borrow pairs have this vault as the liability (borrow) side
const borrowCount = computed(() => {
  return vault.collaterals.filter(ltv => ltv.borrowLTV > 0).length
})
const hasBorrowSideExposure = computed(() => isVaultBorrowable(vault))
// Only show "Current exposure" when something is currently borrowed against
// collateral — idle supply is not exposure, so a vault with nothing utilized
// has no current exposure to show. `utilization` is RPC-derived and always
// known, so this never flickers on loading.
const hasCurrentExposure = computed(() => vault.utilization > 0)
const totalSupplyUsd = ref(0)
const totalSupplyState = ref<ExposureValueState>('loading')
const collateralExposureGroups = computed(() => {
  if (!hasBorrowSideExposure.value) return []

  return getCollateralExposureGroups(
    getCollateralExposurePairs(
      vault,
      addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
    ),
    getOpenInterestForVault(vault.address),
  )
})
const exposureDisplay = computed<VaultExposureDisplay>(() =>
  resolveVaultExposureDisplay({
    openInterestEnabled: isOpenInterestEnabled.value,
    openInterestLoaded: isOpenInterestLoaded.value,
    hasOpenInterestError: hasOpenInterestError.value,
    getCollateralGroups: () => collateralExposureGroups.value,
    totalExposureUsd: totalSupplyUsd.value,
    totalSupplyState: totalSupplyState.value,
    utilization: vault.utilization,
    acceptedCollateralCount: vault.collaterals.length,
  }),
)
const exposureValueState = computed(() => exposureDisplay.value.valueState)
const exposureDisplayItems = computed(() => exposureDisplay.value.items)

const propertyBadgeDetails: Record<VaultPropertyBadge, {
  component: Component
  description: string
  label: string
}> = {
  private: {
    component: KeyringBadge,
    description: 'Vault operations require identity verification before interacting.',
    label: 'Private',
  },
  accessControl: {
    component: AccessControlBadge,
    description: 'Some vault operations are permissioned; approved addresses can perform gated actions.',
    label: 'Access control',
  },
  governanceLimited: {
    component: GovernanceLimitedBadge,
    description: 'Risk parameters are adjustable, but this vault has limited ongoing risk management.',
    label: 'Limited risk management',
  },
  cyclicalNote: {
    component: CyclicalNoteBadge,
    description: 'Interest accrues against a calendar-aligned monthly term that rolls over automatically.',
    label: 'Cyclical note',
  },
}

const propertyBadgeOrder: VaultPropertyBadge[] = ['private', 'accessControl', 'governanceLimited', 'cyclicalNote']
const propertyBadges = computed(() =>
  propertyBadgeOrder
    .filter(badge => badges.value.includes(badge))
    .map(badge => propertyBadgeDetails[badge]),
)

const priceDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(1, vault, 'off-chain')
  priceDisplay.value = price.hasPrice ? formatUsdValue(price.usdValue) : '-'
})

watchEffect(async () => {
  const price = await formatAssetValue(vault.totalAssets, vault, 'off-chain')
  totalSupplyUsd.value = price.hasPrice ? price.usdValue : 0
  totalSupplyState.value = price.hasPrice ? 'ready' : 'unavailable'
})

watchEffect(() => {
  if (!hasBorrowSideExposure.value || !isOpenInterestEnabled.value) return
  void loadOpenInterest()
})
</script>

<template>
  <VaultOverviewAccordionSection
    title="Overview"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-20"
  >
    <VaultDeprecationBanner
      v-if="isDeprecated"
      :reason="deprecationReason"
    />
    <div
      v-if="isRestricted"
      class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
    >
      <div class="flex items-center gap-8">
        <SvgIcon
          name="warning"
          class="!w-20 !h-20 flex-shrink-0"
        />
        <p class="text-p3 text-warning-500">
          This vault is not available in your region.
        </p>
      </div>
    </div>
    <!-- eslint-disable vue/no-v-html -- trusted label content -->
    <p
      v-if="description"
      class="text-p2 text-content-secondary auto-link"
      v-html="autoLink(description)"
    />
    <!-- eslint-enable vue/no-v-html -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-32 gap-y-24">
      <VaultOverviewLabelValue
        label="Price"
        :value="priceDisplay"
      />
      <VaultOverviewLabelValue
        v-if="enableVaultTypeDisplay"
        label="Vault type"
      >
        <VaultTypeChip
          :vault="vault"
          :type="governanceType"
          nudge
          class="w-fit"
        />
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue label="Market">
        <div class="flex min-h-28 items-center">
          <NuxtLink
            v-if="marketProductKey"
            :to="{ name: 'explore-market', params: { market: marketProductKey }, query: { network: route.query.network } }"
            class="text-p2 text-content-primary hover:text-accent-600 underline transition-colors"
            @click="emit('market-click')"
          >
            {{ marketProductName }}
          </NuxtLink>
          <template v-else>
            {{ marketProductName || '-' }}
          </template>
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="enableEntityBrandingDisplay"
        label="Risk manager"
      >
        <VaultTypeChip
          v-if="!isGovernorVerified"
          :vault="vault"
          type="unknown"
          nudge
          class="w-fit"
        />
        <div
          v-else-if="entities.length"
          class="flex flex-col gap-8"
        >
          <div
            v-for="(entity, idx) in entities"
            :key="idx"
            class="flex items-center gap-8"
            :class="{ 'opacity-20': isGovernanceLimited }"
          >
            <BaseAvatar
              :label="entity.name"
              :src="getEulerLabelEntityLogo(entity.logo)"
              class="!w-28 !h-28"
            />
            <a
              v-if="entity.url"
              :href="entity.url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-p2 text-content-primary hover:text-accent-600 underline transition-colors"
            >{{ entity.name }}</a>
            <span
              v-else
              class="text-p2 text-content-primary"
            >{{ entity.name }}</span>
          </div>
        </div>
        <div v-else>
          -
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue label="Can be borrowed">
        <div class="flex min-w-0 items-center gap-8">
          <UiIcon
            class="shrink-0"
            :name="borrowCount ? 'green-tick' : 'red-cross'"
          />
          <span class="text-p2 text-content-primary">
            {{ formatMarketAvailability(borrowCount) }}
          </span>
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="hasBorrowSideExposure && hasCurrentExposure"
        label="Current exposure"
      >
        <VaultExposureSummary
          :items="exposureDisplayItems"
          :value-state="exposureValueState"
          :max-visible="5"
          avatar-size="20"
        />
      </VaultOverviewLabelValue>
    </div>
    <div
      v-if="propertyBadges.length"
      class="flex flex-col gap-20 pt-8"
    >
      <div class="flex items-center gap-12">
        <p class="text-p4 uppercase tracking-[0.14em] text-content-muted whitespace-nowrap">
          Types & properties
        </p>
        <div class="h-2 flex-1 bg-[var(--border-subtle)] opacity-70" />
      </div>
      <div class="flex flex-col">
        <div
          v-for="property in propertyBadges"
          :key="property.label"
          class="flex w-full flex-col items-start gap-8 border-t border-[var(--border-subtle)] py-16 first:border-t-0 first:pt-0 last:pb-0"
        >
          <component
            :is="property.component"
          />
          <span class="text-p3 text-content-tertiary">
            {{ property.description }}
          </span>
        </div>
      </div>
    </div>
  </VaultOverviewAccordionSection>
</template>
