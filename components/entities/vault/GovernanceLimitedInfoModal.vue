<script setup lang="ts">
import { vaultTypeDescriptions } from '~/utils/vault/descriptions'

defineEmits<{ close: [] }>()
</script>

<template>
  <UiInfoModal
    title="Limited Risk Management"
    icon="badge-governance-limited"
    headline="Limited Risk Management"
    :body="vaultTypeDescriptions.governanceLimited"
    @close="$emit('close')"
  />
</template>
