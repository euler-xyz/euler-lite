<script setup lang="ts">
import { KeyringInfoModal } from '#components'

const { size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()
</script>

<template>
  <VaultMetadataBadge
    icon="shield"
    label="Private"
    title="This vault requires identity verification"
    :modal="KeyringInfoModal"
    :size="size"
    :block="block"
    :as="as"
    :nudge="nudge"
  />
</template>
