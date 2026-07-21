<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { UiSelectModal } from '#components'
import type { SelectOption, SelectQuickFilter } from '~/components/ui/modals/select.types'

const model = defineModel<string[]>({ required: true })
const props = defineProps<{
  options: SelectOption[]
  placeholder?: string
  title?: string
  icon?: string
  showSelectedOptions?: boolean
  modalInputPlaceholder?: string
  chipOptions?: SelectOption[]
  quickFilters?: SelectQuickFilter[]
}>()

const modal = useModal()

const displayText = computed(() => {
  if (model.value.length === 0 || !props.showSelectedOptions) {
    return props.placeholder || 'Select...'
  }

  return [...props.options, ...(props.quickFilters ?? [])]
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

const accessibleLabel = computed(() => {
  const label = props.title || props.placeholder || 'Select'
  if (model.value.length === 0) return `${label}: ${displayText.value}`

  const selectedLabels = [...props.options, ...(props.quickFilters ?? [])]
    .filter(option => model.value.includes(option.value))
    .map(option => option.label)
  const selection = selectedLabels.length > 0
    ? selectedLabels.join(', ')
    : `${model.value.length} selected`
  return `${label}: ${selection}`
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
      quickFilters: props.quickFilters,
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
    <button
      type="button"
      class="ui-select__field"
      data-id="filter-trigger"
      :data-filter-title="title || placeholder || 'Select'"
      :data-filter-placeholder="placeholder || 'Select'"
      :data-selected-count="model.length"
      :aria-label="accessibleLabel"
      aria-haspopup="dialog"
      @click="open"
    >
      <UiIcon
        v-if="icon"
        :name="icon"
        class="ui-select__icon"
      />
      <span class="ui-select__text">{{ displayText }}</span>
      <span
        v-if="plusText"
        class="ui-select__plus"
      >{{ plusText }}</span>
      <UiIcon
        v-if="model.length < 3 && !icon"
        name="arrow-down"
        class="ui-select__arrow"
      />
    </button>
    <template v-if="chipOptions && chipOptions.length > 0">
      <UiFilterChip
        v-for="option in chipOptions"
        :key="option.value"
        :active="model.includes(option.value)"
        @click="toggleOption(option.value)"
      >
        {{ option.label }}
        <UiIcon
          v-if="model.includes(option.value)"
          name="close"
          class="ui-filter-chip__icon"
        />
      </UiFilterChip>
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

  &__field {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-grow: 1;
    min-height: 36px;
    color: var(--ui-select-field-color);
    font-size: 14px;
    font-weight: 400;
    padding: 6px 16px;
    background: var(--ui-select-field-background-color);
    border: 1px solid var(--neutral-300);
    border-radius: 100px;
    cursor: pointer;
    transition: all 0.15s ease;
    box-shadow: var(--ui-input-shadow);

    &:hover {
      border-color: var(--neutral-400);
      background: var(--neutral-50);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
    }

    &:focus {
      border-color: var(--accent-500);
      box-shadow: var(--ui-input-focus-shadow);
    }
  }

  &__icon {
    width: 16px;
    height: 16px;
  }

  &__text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    border-radius: 100px;
  }

  &__arrow {
    width: 16px;
    height: 16px;
    margin-left: auto;
    margin-right: -4px;
  }
}
</style>
