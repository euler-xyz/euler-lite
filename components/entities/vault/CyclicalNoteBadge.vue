<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { CyclicalNoteInfoModal } from '#components'

const { size = 'small' } = defineProps<{
  size?: 'small' | 'large'
}>()

const modal = useModal()

const openInfoModal = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(CyclicalNoteInfoModal)
}
</script>

<template>
  <button
    type="button"
    class="cyclical-note-badge inline-flex items-center cursor-pointer"
    :class="size === 'large'
      ? 'gap-8 py-8 px-12 rounded-8'
      : 'gap-4 py-2 px-8 rounded-8 text-p5'"
    title="Fixed-rate vault with recurring cycles"
    @click="openInfoModal"
  >
    <SvgIcon
      name="refresh"
      :class="size === 'large' ? '!w-20 !h-20 mr-2' : '!w-14 !h-14'"
    />
    Cyclical note
  </button>
</template>

<style scoped lang="scss">
.cyclical-note-badge {
  border: 0;
  background-color: rgba(var(--accent-rgb), 0.15);
  color: var(--accent-600);

  [data-theme="dark"] & {
    background-color: rgba(var(--accent-rgb), 0.2);
    color: var(--accent-500);
  }
}
</style>
