<script setup lang="ts">
const emits = defineEmits(['close'])

type SortOption = { label: string, icon?: string }

const { options, selected, onSave } = defineProps<{
  options: SortOption[]
  selected?: string
  title?: string
  onSave: (selected: string) => void
}>()

const selectedIdx = ref(options.findIndex(option => option.label === selected))

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    :title="title"
    @close="handleClose"
  >
    <div
      v-for="(option, idx) in options"
      :key="`options-${idx}`"
      class="flex items-center gap-12 py-12 px-16 cursor-pointer rounded-16"
      :class="[selectedIdx === idx ? 'bg-card-hover' : '']"
      @click="onSave(option.label)"
    >
      <UiIcon
        v-if="option.icon"
        :name="option.icon"
        class="!w-20 !h-20 text-content-secondary flex-shrink-0"
      />
      <div class="grow-1">
        <div class="text-content-primary mb-2">
          {{ option.label }}
        </div>
      </div>
    </div>
  </BaseModalWrapper>
</template>
