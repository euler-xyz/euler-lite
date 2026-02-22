<script setup lang="ts">
import { getAddress, zeroAddress } from 'viem'
import type { Vault } from '~/entities/vault'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { useEulerEntitiesOfVault, useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getProductKeyByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { autoLink } from '~/utils/autoLink'

const { vault } = defineProps<{ vault: Vault }>()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { borrowList, isVaultGovernorVerified } = useVaults()

const vaultAddress = computed(() => getAddress(vault.address))
const product = useEulerProductOfVault(vaultAddress)
const entities = useEulerEntitiesOfVault(vault)
const marketProductKey = computed(() => getProductKeyByVault(vault.address))

const isDeprecated = computed(() => {
  return product.deprecatedVaults?.includes(vaultAddress.value) ?? false
})
const deprecationReason = computed(() => isDeprecated.value ? product.deprecationReason : '')
const isRestricted = computed(() => isVaultBlockedByCountry(vault.address))
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault))
const isGovernanceLimited = computed(() => product.isGovernanceLimited && isGovernorVerified.value)

// Count how many borrow pairs have this vault as collateral
const collateralCount = computed(() => {
  return borrowList.value.filter(pair => pair.collateral.address === vault.address).length
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

const vaultGovernanceType = computed(() => {
  // Escrow vault
  if (vault.vaultCategory === 'escrow') {
    return 'escrow'
  }
  // Has matching entity → governed
  if (entities.length) {
    return 'governed'
  }
  // Zero governorAdmin → ungoverned
  if (!vault.governorAdmin || vault.governorAdmin === zeroAddress) {
    return 'ungoverned'
  }
  // Non-zero but no matching entity → unknown
  return 'unknown'
})
</script>

<template>
  <div class="flex flex-col gap-16 p-24 border-b border-line-default last:border-b-0">
    <p class="text-h3 text-content-primary">
      Overview
    </p>
    <div class="flex flex-col items-start gap-16">
      <div
        v-if="isDeprecated && deprecationReason"
        class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
      >
        <div class="flex items-start gap-8">
          <SvgIcon
            name="warning"
            class="!w-20 !h-20 flex-shrink-0 mt-2"
          />
          <p
            class="text-p3 text-warning-500 auto-link"
            v-html="autoLink(deprecationReason)"
          />
        </div>
      </div>
      <div
        v-if="isRestricted"
        class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
      >
        <div class="flex items-start gap-8">
          <SvgIcon
            name="warning"
            class="!w-20 !h-20 flex-shrink-0 mt-2"
          />
          <p class="text-p3 text-warning-500">
            This vault is not available in your region.
          </p>
        </div>
      </div>
      <div
        v-if="product.description"
        class="w-full rounded-12 p-16 bg-surface-tertiary"
      >
        <p
          class="text-p3 text-content-secondary auto-link"
          v-html="autoLink(product.description)"
        />
      </div>
      <VaultOverviewLabelValue
        label="Price"
        :value="priceDisplay"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue label="Market">
        <NuxtLink
          v-if="marketProductKey"
          :to="{ name: 'explore-market', params: { market: marketProductKey } }"
          class="text-p2 text-content-primary hover:text-accent-600 underline transition-colors"
        >
          {{ product.name }}
        </NuxtLink>
        <template v-else>
          {{ product.name || '-' }}
        </template>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="enableEntityBrandingDisplay"
        label="Risk manager"
      >
        <div
          v-if="!isGovernorVerified"
          class="flex gap-8 items-center py-8 px-12 rounded-8 bg-[var(--c-red-opaque-200)] text-red-700"
        >
          <UiIcon
            class="mr-2 !w-20 !h-20"
            name="warning"
          />
          Unknown
        </div>
        <div
          v-else-if="isGovernanceLimited"
        >
          -
        </div>
        <div
          v-else-if="entities.length"
          class="flex flex-col gap-16"
        >
          <div
            v-for="(entity, idx) in entities"
            :key="idx"
            class="flex items-center gap-8"
          >
            <BaseAvatar
              :label="entity.name"
              :src="getEulerLabelEntityLogo(entity.logo)"
            />
            <a
              :href="entity.url"
              target="_blank"
              class="text-p2 text-content-primary hover:text-accent-600 underline transition-colors"
            >{{ entity.name }}</a>
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
        <VaultTypeChip
          :vault="vault"
          :type="vaultGovernanceType"
        />
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue label="Can be borrowed">
        <div class="flex items-center gap-8">
          <div>
            <UiIcon :name="borrowCount ? 'green-tick' : 'red-cross'" />
          </div>
          <span class="text-p2 text-content-primary">
            {{ borrowCount ? `Yes in ${borrowCount} markets` : 'No' }}
          </span>
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue label="Can be used as collateral">
        <div class="flex items-center gap-8">
          <div>
            <UiIcon :name="collateralCount ? 'green-tick' : 'red-cross'" />
          </div>
          <span class="text-p2 text-content-primary">
            {{ collateralCount ? `Yes in ${collateralCount} markets` : 'No' }}
          </span>
        </div>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
