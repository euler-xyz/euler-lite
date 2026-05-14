<script setup lang="ts">
import { getAddress } from 'viem'
import type { Vault } from '~/entities/vault'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { useEulerEntitiesOfVault, useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getProductByVault, getProductKeyByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { autoLink } from '~/utils/autoLink'

const { vault } = defineProps<{ vault: Vault }>()
const route = useRoute()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { isVaultGovernorVerified } = useVaults()
const { getEvkVaults } = useVaultRegistry()

const vaultAddress = computed(() => getAddress(vault.address))
const product = useEulerProductOfVault(vaultAddress)
const entities = useEulerEntitiesOfVault(vault)
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

// Count how many EVK vaults reference this vault as a borrowable collateral.
// Sources from the registry directly (not `borrowList`) so deep-linked
// unverified pairs still report "Yes in N markets" — `borrowList` is filtered
// to verified vaults for discovery views and would otherwise hide the
// relationship even though we're literally rendering it. Mirrors the pattern
// in SecuritizeVaultOverview.vue.
const collateralCount = computed(() => {
  return getEvkVaults().filter(v => v.collateralLTVs.some(
    ltv => ltv.collateral === vault.address && ltv.borrowLTV > 0n,
  )).length
})

// Count how many borrow pairs have this vault as the liability (borrow) side
const borrowCount = computed(() => {
  return vault.collateralLTVs.filter(ltv => ltv.borrowLTV > 0n).length
})

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
      <div class="grid grid-cols-2 gap-x-32 gap-y-24">
        <VaultOverviewLabelValue
          label="Price"
          :value="priceDisplay"
        />
        <VaultOverviewLabelValue label="Market">
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
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue
          v-if="enableEntityBrandingDisplay"
          label="Risk manager"
        >
          <VaultTypeChip
            v-if="!isGovernorVerified"
            :vault="vault"
            type="unknown"
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
        <VaultOverviewLabelValue
          v-if="enableVaultTypeDisplay"
          label="Vault type"
        >
          <VaultTypeBadges :vault="vault" />
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
    </div>
  </div>
</template>
