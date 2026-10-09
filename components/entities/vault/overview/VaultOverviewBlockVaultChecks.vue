<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'

type VaultChecksTarget = {
  address: string
  symbol?: string
  family?: VaultAssessmentFamily
  asset?: { decimals: number, symbol?: string }
}

const props = defineProps<{
  address?: string
  vaults?: VaultChecksTarget[]
  family?: VaultAssessmentFamily
  asset?: { decimals: number, symbol?: string }
  defaultOpen?: boolean
}>()
const { chainId } = useEulerAddresses()
const { source, isVaultAssessmentAvailableForChain } = useEulerLabels()
const canShow = computed(() => !!chainId.value
  && source.value === 'v3'
  && isVaultAssessmentAvailableForChain(chainId.value))
const cards = computed<VaultChecksTarget[]>(() => {
  if (props.vaults?.length) return props.vaults
  return props.address ? [{ address: props.address, family: props.family, asset: props.asset }] : []
})
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="canShow && cards.length"
    title="Vault checks"
    :default-open="props.defaultOpen ?? false"
    content-class="flex flex-col gap-16"
  >
    <VaultOverviewBlockVaultChecksCard
      v-for="card in cards"
      :key="card.address"
      :address="card.address"
      :family="card.family"
      :asset="card.asset"
      :symbol="cards.length > 1 ? card.symbol : undefined"
    />
  </VaultOverviewAccordionSection>
</template>
