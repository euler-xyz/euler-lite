<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { KeyringInfoModal } from '#components'

const { size = 'small' } = defineProps<{
  size?: 'small' | 'large'
}>()

const modal = useModal()

const openKeyringInfoModal = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(KeyringInfoModal)
}
</script>

<template>
  <span
    class="keyring-badge inline-flex items-center cursor-pointer"
    :class="size === 'large'
      ? 'gap-8 py-8 px-12 rounded-8'
      : 'gap-4 py-2 px-8 rounded-8 text-p5'"
    title="This vault requires identity verification"
    @click="openKeyringInfoModal"
  >
    <SvgIcon
      name="shield"
      :class="size === 'large' ? '!w-20 !h-20 mr-2' : '!w-14 !h-14'"
    />
    Private
  </span>
</template>

<style scoped lang="scss">
.keyring-badge {
  background-color: rgba(var(--accent-rgb), 0.15);
  color: var(--accent-600);

  [data-theme="dark"] & {
    background-color: rgba(var(--accent-rgb), 0.2);
    color: var(--accent-500);
  }
}
</style>
