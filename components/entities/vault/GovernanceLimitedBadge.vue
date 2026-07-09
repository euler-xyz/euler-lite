<script setup lang="ts">
import { GovernanceLimitedInfoModal } from '#components'

const { size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()
</script>

<template>
  <VaultMetadataBadge
    icon="pulse"
    label="Limited"
    title="This vault has limited risk management"
    :modal="GovernanceLimitedInfoModal"
    :size="size"
    :block="block"
    :as="as"
    :nudge="nudge"
  />
</template>
