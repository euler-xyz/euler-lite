<script setup lang="ts">
import { AccessControlInfoModal } from '#components'

const { size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()
</script>

<template>
  <VaultMetadataBadge
    icon="badge-access-control"
    active-icon="badge-access-control-filled"
    label="Access control"
    title="This vault restricts operations to allowlisted addresses"
    :modal="AccessControlInfoModal"
    :size="size"
    :block="block"
    :as="as"
    :nudge="nudge"
  />
</template>
