<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'

import { formatAssetValue } from '~/utils/sdk-prices'
import { useEulerEntitiesOfEarnVault, useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getEarnVaultDescription } from '~/utils/eulerLabelsUtils'
import { autoLink } from '~/utils/autoLink'
import { FLAGGED_VAULT_LABEL } from '~/utils/vault-assessment/flagged'

const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { isEarnVaultOwnerVerified } = useVaults()
const vaultAddress = computed(() => getAddress(vault.address))
const product = useEulerProductOfVault(vaultAddress)
const entities = useEulerEntitiesOfEarnVault(vault)
const isFlagged = useFlaggedVault(() => vault.address)
const isOwnerVerified = computed(() => isEarnVaultOwnerVerified(vault))
const earnDescription = computed(() => getEarnVaultDescription(vault.address))

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
    icon="section-overview"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-20"
  >
    <VaultDeprecationBanner :addresses="[vault.address]" />
    <VaultPublicNotice
      :addresses="[vault.address]"
      family="earn"
    />
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
            <CuratorEntityLink :entities="[entity]" />
          </div>
        </div>
        <VaultTypeChip
          v-else-if="!isFlagged"
          :vault="vault"
          type="unknown"
          nudge
          class="w-fit"
        />
        <span
          v-else
          class="text-p2 text-content-tertiary"
        >{{ FLAGGED_VAULT_LABEL }}</span>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="enableVaultTypeDisplay"
        label="Vault type"
      >
        <VaultTypeBadges
          v-if="!isFlagged"
          :vault="vault"
          nudge
        />
        <span
          v-else
          class="text-p2 text-content-tertiary"
        >-</span>
      </VaultOverviewLabelValue>
    </div>
  </VaultOverviewAccordionSection>
</template>
