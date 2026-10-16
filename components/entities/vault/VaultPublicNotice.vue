<script setup lang="ts">
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { getEarnVaultNotice, getVaultNotice } from '~/utils/eulerLabelsUtils'

const props = defineProps<{ addresses: string[], family?: 'earn' | 'vault' }>()
const notices = computed(() => {
  getEulerLabelsVersion()
  return [...new Set(props.addresses
    .map(address => props.family === 'earn' ? getEarnVaultNotice(address) : getVaultNotice(address))
    .filter(Boolean))]
})
</script>

<template>
  <PortfolioNotice
    v-for="notice in notices"
    :key="notice"
    :notice="notice"
    class="!border-0"
  />
</template>
