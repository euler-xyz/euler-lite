<script setup lang="ts">
import { getVaultGeoUnavailableReason } from '~/composables/useGeoBlock'
import { ADDRESS_EXIT_ONLY_TITLE, isAddressExitOnly } from '~/composables/addressExitOnlyState'

const { vaultAddresses, description, title = 'Region restricted' } = defineProps<{
  vaultAddresses: (string | undefined)[]
  description?: string
  title?: string
}>()
const unavailable = computed(() => getVaultGeoUnavailableReason(...vaultAddresses))
const alertTitle = computed(() => {
  if (isAddressExitOnly.value) return ADDRESS_EXIT_ONLY_TITLE
  return unavailable.value ? 'Availability not confirmed' : title
})
</script>

<template>
  <UiAlert
    :title="alertTitle"
    :description="unavailable || description"
    variant="warning"
    size="compact"
  />
</template>
