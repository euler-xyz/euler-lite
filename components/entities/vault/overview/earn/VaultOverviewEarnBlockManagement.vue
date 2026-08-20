<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { formatTtl } from '~/utils/crypto-utils'

const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()

const vaultAddressesInfo = computed(() => ([
  {
    title: `Owner`,
    address: vault.governance.owner,
  },
  {
    title: `Curator`,
    address: vault.governance.curator,
  },
  {
    title: `Guardian`,
    address: vault.governance.guardian,
  },
]))

const timelockDisplay = computed(() => {
  if (vault.governance.timelock === 0) {
    return '0 days'
  }

  const timelockInSeconds = vault.governance.timelock
  const timelockInDays = BigInt(Math.floor(timelockInSeconds / 86400))
  return formatTtl(timelockInDays)?.display || 'Unknown'
})
</script>

<template>
  <VaultOverviewAccordionSection
    title="Management"
    :default-open="defaultOpen"
    content-class="flex flex-col items-start gap-24"
  >
    <VaultOverviewLabelValue
      v-for="infoItem in vaultAddressesInfo"
      :key="infoItem.title"
      :label="infoItem.title"
      orientation="horizontal"
    >
      <VaultOverviewAddressValue
        :address="infoItem.address"
        check-safe
      />
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      label="Timelock"
      orientation="horizontal"
    >
      <span class="pr-[22px]">{{ timelockDisplay }}</span>
    </VaultOverviewLabelValue>
  </VaultOverviewAccordionSection>
</template>
