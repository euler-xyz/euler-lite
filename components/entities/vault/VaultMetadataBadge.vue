<script setup lang="ts">
import type { Component } from 'vue'
import { useModal } from '~/components/ui/composables/useModal'

const { modal, size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  icon: string
  label: string
  title: string
  modal: Component
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()

const modalManager = useModal()

const openInfoModal = (event: MouseEvent | KeyboardEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modalManager.open(modal)
}
</script>

<template>
  <VaultMetadataTag
    :as="as"
    :icon="icon"
    :label="label"
    tone="accent"
    :size="size"
    :block="block"
    :nudge="nudge"
    :title="title"
    @click="openInfoModal"
  />
</template>
