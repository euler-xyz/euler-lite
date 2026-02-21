<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { UiSelectModal } from '#components'

const model = defineModel<string[]>({ required: true })
const props = defineProps<{
  options: { label: string, value: string, icon?: string }[]
  placeholder?: string
  title?: string
  icon?: string
  showSelectedOptions?: boolean
  modalInputPlaceholder?: string
  chipOptions?: { label: string, value: string, icon?: string }[]
}>()

const modal = useModal()

const displayText = computed(() => {
  if (model.value.length === 0 || !props.showSelectedOptions) {
    return props.placeholder || 'Select...'
  }

  return props.options
    .filter(opt => model.value.includes(opt.value))
    .map(opt => opt.label)
    .slice(0, 2)
    .join(', ')
})

const plusText = computed(() => {
  if (
    (props.showSelectedOptions && model.value.length < 3)
    || (!props.showSelectedOptions && !model.value.length)
  ) {
    return null
  }

  return `+${props.showSelectedOptions ? model.value.length - 2 : model.value.length}`
})

const toggleOption = (value: string) => {
  if (model.value.includes(value)) {
    model.value = model.value.filter(v => v !== value)
  }
  else {
    model.value.push(value)
  }
}

const open = () => {
  modal.open(UiSelectModal, {
    props: {
      selected: model.value,
      options: props.options,
      title: props.title,
      inputPlaceholder: props.modalInputPlaceholder,
      onSave: (selected: string[]) => {
        model.value = selected
      },
    },
  })
}
</script>

<template>
  <div
    :class="['ui-select', { 'ui-select--chips': chipOptions && chipOptions.length > 0 }]"
  >
    <div
      class="flex items-center gap-6 shrink-0 min-h-36 text-content-secondary text-[14px] py-6 px-13 bg-surface border border-line-default rounded-none cursor-pointer hover:border-line-emphasis hover:bg-surface-secondary transition-all"
      @click="open"
    >
      <UiIcon
        v-if="icon"
        :name="icon"
        class="!w-16 !h-16 text-content-tertiary"
      />
      <span class="whitespace-nowrap overflow-hidden text-ellipsis">{{ displayText }}</span>
      <span
        v-if="plusText"
        class="ui-select__plus"
      >{{ plusText }}</span>
      <UiIcon
        v-if="model.length < 3 && !icon"
        name="arrow-down"
        class="!w-16 !h-16 ml-auto -mr-4 text-content-secondary"
      />
    </div>
    <template v-if="chipOptions && chipOptions.length > 0">
      <div
        v-for="option in chipOptions"
        :key="option.value"
        :class="['ui-select__chip', { 'ui-select__chip--active': model.includes(option.value) }]"
        @click="toggleOption(option.value)"
      >
        {{ option.label }}
        <UiIcon
          v-if="model.includes(option.value)"
          name="close"
          class="ui-select__chip-icon"
        />
      </div>
    </template>
  </div>
</template>

<style lang="scss">
.ui-select {
  position: relative;

  &--chips {
    display: flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    max-width: 100%;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  &__plus {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    color: var(--ui-select-plus-color);
    font-size: 14px;
    font-weight: 400;
    padding: 2px 6px;
    margin-left: auto;
    margin-right: -10px;
    background: var(--ui-select-plus-background-color);
    border-radius: 0;
  }

  &__arrow {
    width: 16px;
    height: 16px;
    margin-left: auto;
    margin-right: -4px;
  }

  &__chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    min-height: 36px;
    font-size: 14px;
    font-weight: 400;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 0;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;

    &:hover {
      border-color: var(--border-emphasis);
      background: var(--bg-surface-secondary);
    }

    &--active {
      font-weight: 600;
      background: var(--ui-select-chip-active-background-color);
      color: var(--ui-select-chip-active-color);
      border-color: transparent;

      &:hover {
        background: var(--accent-600);
        border-color: transparent;
      }
    }
  }

  &__chip-icon {
    width: 16px;
    height: 16px;
  }
}
</style>
