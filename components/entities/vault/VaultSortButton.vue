<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { VaultSortTypeModal } from '#components'

const model = defineModel<string>({ required: true })
const dir = defineModel<'desc' | 'asc'>('dir', { default: 'desc' })
const props = defineProps<{
  options: string[]
  placeholder?: string
  title?: string
  disableDir?: boolean
}>()

const modal = useModal()

const open = () => {
  modal.open(VaultSortTypeModal, {
    props: {
      selected: model.value,
      options: props.options,
      title: props.title,
      onSave: (selected: string) => {
        model.value = selected
        modal.close()
      },
    },
  })
}

const toggleDir = (e: Event) => {
  e.stopPropagation()
  if (props.disableDir) return
  dir.value = dir.value === 'desc' ? 'asc' : 'desc'
}
</script>

<template>
  <div
    class="relative flex items-center gap-6 flex-shrink-0 min-h-36 text-content-secondary py-6 pl-16 pr-8 bg-surface border border-line-default rounded-none cursor-pointer hover:border-line-emphasis hover:bg-surface-secondary transition-all"
    @click="open"
  >
    <UiIcon
      name="sort"
      class="!w-16 !h-16 text-content-tertiary"
    />
    <span class="whitespace-nowrap overflow-hidden text-ellipsis">{{ placeholder }}</span>
    <span
      v-if="model"
      class="whitespace-nowrap overflow-hidden text-ellipsis"
    >{{ model }}</span>
    <button
      class="flex items-center justify-center w-20 h-20 rounded-full transition-all"
      :class="disableDir ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-tertiary'"
      :disabled="disableDir"
      @click="toggleDir"
    >
      <UiIcon
        name="arrow-down"
        class="!w-16 !h-16 text-content-secondary transition-transform"
        :class="{ 'rotate-180': dir === 'asc' }"
      />
    </button>
  </div>
</template>
