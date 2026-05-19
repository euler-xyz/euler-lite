<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { KeyringInfoModal } from '#components'

const { size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()

const modal = useModal()

const openKeyringInfoModal = (event: MouseEvent | KeyboardEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(KeyringInfoModal)
}
</script>

<template>
  <VaultMetadataTag
    :as="as"
    icon="shield"
    label="Private"
    tone="accent"
    :size="size"
    :block="block"
    :nudge="nudge"
    title="This vault requires identity verification"
    @click="openKeyringInfoModal"
  />
</template>
