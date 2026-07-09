<script setup lang="ts">
import { vaultTypeDescriptions } from '~/utils/vault/descriptions'

defineEmits<{ close: [] }>()
</script>

<template>
  <UiInfoModal
    title="Limited Risk Management"
    icon="pulse"
    headline="Limited Risk Management"
    :body="vaultTypeDescriptions.governanceLimited"
    @close="$emit('close')"
  />
</template>
