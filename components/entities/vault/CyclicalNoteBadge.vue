<script setup lang="ts">
import { CyclicalNoteInfoModal } from '#components'

const { size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()
</script>

<template>
  <VaultMetadataBadge
    icon="refresh"
    label="Cyclical note"
    title="Fixed-rate vault with recurring cycles"
    :modal="CyclicalNoteInfoModal"
    :size="size"
    :block="block"
    :as="as"
    :nudge="nudge"
  />
</template>
