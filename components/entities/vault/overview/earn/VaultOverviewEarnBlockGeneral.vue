<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'

import { formatAssetValue } from '~/utils/sdk-prices'
import { useEulerEntitiesOfEarnVault, useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isEarnVaultDeprecated, getEarnVaultDeprecationReason, getEarnVaultDescription } from '~/utils/eulerLabelsUtils'
import { autoLink } from '~/utils/autoLink'

const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { isEarnVaultOwnerVerified } = useVaults()
const vaultAddress = computed(() => getAddress(vault.address))
const product = useEulerProductOfVault(vaultAddress)
const entities = useEulerEntitiesOfEarnVault(vault)
const isOwnerVerified = computed(() => isEarnVaultOwnerVerified(vault))
const earnDescription = computed(() => getEarnVaultDescription(vault.address))

const isDeprecated = computed(() => {
  return isEarnVaultDeprecated(vault.address)
    || (product.deprecatedVaults?.includes(vaultAddress.value) ?? false)
})
const deprecationReason = computed(() => {
  if (!isDeprecated.value) return ''
  return getEarnVaultDeprecationReason(vault.address) || product.deprecationReason || ''
})
const isRestricted = computed(() => isVaultBlockedByCountry(vault.address))

const priceDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(1, vault, 'off-chain')
  priceDisplay.value = price.hasPrice ? formatUsdValue(price.usdValue) : '-'
})

const feeDisplay = computed(() => {
  const performanceFee = Number(vault.performanceFee)

  return Number.isFinite(performanceFee)
    ? `${compactNumber(performanceFee * 100, 2, 2)}%`
    : '-'
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
    <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
    <p
      v-if="earnDescription"
      class="text-p2 text-content-secondary auto-link"
      v-html="autoLink(earnDescription)"
    />
    <p
      v-if="product.description"
      class="text-p2 text-content-secondary auto-link"
      v-html="autoLink(product.description)"
    />
    <!-- eslint-enable vue/no-v-html -->
    <div class="grid grid-cols-2 gap-x-32 gap-y-24">
      <VaultOverviewLabelValue
        label="Price"
        :value="priceDisplay"
      />
      <VaultOverviewLabelValue
        label="Performance fee"
        :value="feeDisplay"
      />
      <VaultOverviewLabelValue
        v-if="enableEntityBrandingDisplay"
        label="Curator"
      >
        <div
          v-if="entities.length && isOwnerVerified"
          class="flex flex-col gap-8"
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
              v-if="entity.url"
              :href="entity.url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-p2 text-neutral-800 hover:text-accent-600 underline transition-colors"
            >{{ entity.name }}</a>
            <span
              v-else
              class="text-p2 text-neutral-800"
            >{{ entity.name }}</span>
          </div>
        </div>
        <VaultTypeChip
          v-else
          :vault="vault"
          type="unknown"
          nudge
          class="w-fit"
        />
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="enableVaultTypeDisplay"
        label="Vault type"
      >
        <VaultTypeBadges
          :vault="vault"
          nudge
        />
      </VaultOverviewLabelValue>
    </div>
  </VaultOverviewAccordionSection>
</template>
