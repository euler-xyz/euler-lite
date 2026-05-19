<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { CyclicalNoteInfoModal } from '#components'

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
  modal.open(CyclicalNoteInfoModal)
}
</script>

<template>
  <VaultMetadataTag
    :as="as"
    icon="refresh"
    label="Cyclical note"
    tone="accent"
    :size="size"
    :block="block"
    :nudge="nudge"
    title="Fixed-rate vault with recurring cycles"
    @click="openInfoModal"
  />
</template>
