<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { AccessControlInfoModal } from '#components'

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
  modal.open(AccessControlInfoModal)
}
</script>

<template>
  <VaultMetadataTag
    :as="as"
    icon="search-user"
    label="Access control"
    tone="accent"
    :size="size"
    :block="block"
    :nudge="nudge"
    title="This vault restricts operations to allowlisted addresses"
    @click="openInfoModal"
  />
</template>
