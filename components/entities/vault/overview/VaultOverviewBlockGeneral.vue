<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import type { Component } from 'vue'

import { formatAssetValue } from '~/utils/sdk-prices'
import { useEulerEntitiesOfVault, useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getProductByVault, getProductKeyByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { autoLink } from '~/utils/autoLink'
import { normalizeAddress } from '~/utils/normalizeAddress'
import type { VaultTypeBadge } from '~/composables/useVaultTypeBadges'
import { AccessControlBadge, CyclicalNoteBadge, GovernanceLimitedBadge, KeyringBadge } from '#components'

const { vault } = defineProps<{ vault: EVault }>()
const route = useRoute()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { isVaultGovernorVerified } = useVaults()
const { getEVaults } = useVaultRegistry()

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
const isGovernanceLimited = computed(() => product.isGovernanceLimited && isGovernorVerified.value)

// Count how many EVaults reference this vault as a borrowable collateral.
// Use the registry directly, matching the baseline app. `borrowList` is
// filtered for visible borrow discovery pairs and undercounts deep-linked or
// otherwise filtered relationships.
const collateralCount = computed(() => {
  return getEVaults().filter(v => v.collaterals.some(
    ltv => normalizeAddress(ltv.address) === vaultAddress.value && ltv.borrowLTV > 0,
  )).length
})

// Count how many borrow pairs have this vault as the liability (borrow) side
const borrowCount = computed(() => {
  return vault.collaterals.filter(ltv => ltv.borrowLTV > 0).length
})

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

const hasPropertiesDetails = computed(() =>
  !!marketProductName.value
  || enableEntityBrandingDisplay
  || propertyBadges.value.length > 0,
)

const priceDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(1, vault, 'off-chain')
  priceDisplay.value = price.hasPrice ? formatUsdValue(price.usdValue) : '-'
})
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Overview
    </p>
    <div class="flex flex-col gap-20">
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
        <VaultOverviewLabelValue label="Can be borrowed">
          <div class="flex items-center gap-8">
            <UiIcon :name="borrowCount ? 'green-tick' : 'red-cross'" />
            <span class="text-p2 text-content-primary">
              {{ borrowCount ? `Yes in ${borrowCount} markets` : 'No' }}
            </span>
          </div>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Can be used as collateral">
          <div class="flex items-center gap-8">
            <UiIcon :name="collateralCount ? 'green-tick' : 'red-cross'" />
            <span class="text-p2 text-content-primary">
              {{ collateralCount ? `Yes in ${collateralCount} markets` : 'No' }}
            </span>
          </div>
        </VaultOverviewLabelValue>
      </div>
      <div
        v-if="hasPropertiesDetails"
        class="flex flex-col gap-20 pt-8"
      >
        <div class="flex items-center gap-12">
          <p class="text-p4 uppercase tracking-[0.14em] text-content-muted whitespace-nowrap">
            Types & properties
          </p>
          <div class="h-2 flex-1 bg-[var(--border-subtle)] opacity-70" />
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-32 gap-y-24">
          <VaultOverviewLabelValue label="Market">
            <div class="flex min-h-28 items-center">
              <NuxtLink
                v-if="marketProductKey"
                :to="{ name: 'explore-market', params: { market: marketProductKey }, query: { network: route.query.network } }"
                class="text-p2 text-content-primary hover:text-accent-600 underline transition-colors"
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
        </div>
        <div
          v-if="propertyBadges.length"
          class="flex flex-col"
        >
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
    </div>
  </div>
</template>
