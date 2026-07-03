<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { GovernanceLimitedInfoModal } from '#components'

const { size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()

const modal = useModal()

const openInfoModal = (event: MouseEvent | KeyboardEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(GovernanceLimitedInfoModal)
}
</script>

<template>
  <VaultMetadataTag
    :as="as"
    icon="pulse"
    label="Limited"
    tone="accent"
    :size="size"
    :block="block"
    :nudge="nudge"
    title="This vault has limited risk management"
    @click="openInfoModal"
  />
</template>
