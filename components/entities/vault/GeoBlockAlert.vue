<script setup lang="ts">
import { getVaultGeoUnavailableReason } from '~/composables/useGeoBlock'

const { vaultAddresses, description, title = 'Region restricted' } = defineProps<{
  vaultAddresses: (string | undefined)[]
  description?: string
  title?: string
}>()
const unavailable = computed(() => getVaultGeoUnavailableReason(...vaultAddresses))
</script>

<template>
  <UiAlert
    :title="unavailable ? 'Availability not confirmed' : title"
    :description="unavailable || description"
    variant="warning"
    size="compact"
  />
</template>
