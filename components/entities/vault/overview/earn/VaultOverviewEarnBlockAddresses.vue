<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'

const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()

const vaultAddresesInfo = computed(() => ([
  {
    title: `${vault.asset.symbol} token`,
    address: vault.asset.address,
  },
  {
    title: `${vault.asset.symbol} vault`,
    address: vault.address,
  },
  {
    title: `Fee receiver`,
    address: vault.governance.feeReceiver,
    checkSafe: true,
  },
]))
</script>

<template>
  <VaultOverviewAccordionSection
    title="Addresses"
    :default-open="defaultOpen"
    content-class="flex flex-col items-start gap-24"
  >
    <VaultOverviewLabelValue
      v-for="infoItem in vaultAddresesInfo"
      :key="infoItem.title"
      :label="infoItem.title"
      orientation="horizontal"
    >
      <VaultOverviewAddressValue
        :address="infoItem.address"
        :check-safe="infoItem.checkSafe"
      />
    </VaultOverviewLabelValue>
  </VaultOverviewAccordionSection>
</template>
