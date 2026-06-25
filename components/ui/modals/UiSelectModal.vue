<script setup lang="ts">
import type { SelectOption, SelectQuickFilter } from './select.types'

const props = defineProps<{
  selected: string[]
  options: SelectOption[]
  quickFilters?: SelectQuickFilter[]
  title?: string
  inputPlaceholder?: string
  onSave?: (selected: string[]) => void
}>()
const emit = defineEmits(['close'])

const localSelected = ref<string[]>([...props.selected])
const selectedPrioritySet = ref(new Set(props.selected))
const searchModel = ref('')
const quickFilterValues = computed(() => new Set((props.quickFilters ?? []).map(filter => filter.value)))

const isOptionSelected = (option: SelectOption): boolean => {
  if (localSelected.value.includes(option.value)) return true
  return option.quickFilterValues?.some(value => localSelected.value.includes(value)) ?? false
}

const activeQuickFilterValue = computed(() =>
  (props.quickFilters ?? []).find(filter => localSelected.value.includes(filter.value))?.value ?? null,
)

const filteredOptions = computed(() => {
  const options = searchModel.value
    ? props.options.filter((option) => {
        return option.label.replace('₮', 'T').toLowerCase().includes(searchModel.value.toLowerCase())
      })
    : props.options

  const selectedFirst: typeof props.options = []
  const unselected: typeof props.options = []
  options.forEach((option) => {
    if (selectedPrioritySet.value.has(option.value) || isOptionSelected(option)) {
      selectedFirst.push(option)
      return
    }
    unselected.push(option)
  })
  return [...selectedFirst, ...unselected]
})

const toggleQuickFilter = (value: string | null) => {
  if (!value) {
    localSelected.value = []
    return
  }

  localSelected.value = activeQuickFilterValue.value === value ? [] : [value]
}

const toggleOption = (option: SelectOption) => {
  const activeQuickFilter = activeQuickFilterValue.value
  if (activeQuickFilter && option.quickFilterValues?.includes(activeQuickFilter)) {
    localSelected.value = props.options
      .filter(candidate => candidate.quickFilterValues?.includes(activeQuickFilter))
      .map(candidate => candidate.value)
      .filter(value => value !== option.value)
    return
  }

  const idx = localSelected.value.indexOf(option.value)
  if (idx > -1) {
    localSelected.value.splice(idx, 1)
  }
  else {
    localSelected.value = [
      ...localSelected.value.filter(value => !quickFilterValues.value.has(value)),
      option.value,
    ]
  }
}

const save = () => {
  props.onSave?.(localSelected.value)
  emit('close')
}

const close = () => {
  emit('close')
}

const clear = () => {
  localSelected.value = []
  props.onSave?.(localSelected.value)
  emit('close')
}

watch(() => props.selected, (val) => {
  localSelected.value = [...val]
  selectedPrioritySet.value = new Set(val)
})
</script>

<template>
  <BaseModalWrapper
    class="ui-select-modal"
    data-id="select-modal"
    :data-modal-title="title || 'Select options'"
    :title="title || 'Select options'"
    :full="false"
    @close="close"
  >
    <div class="ui-select-modal__content">
      <UiInput
        v-model="searchModel"
        :placeholder="inputPlaceholder || 'Search'"
        :class="quickFilters?.length ? 'mb-12' : 'mb-16'"
        icon="search"
      />
      <div
        v-if="quickFilters?.length"
        class="ui-select-modal__quick-filters"
      >
        <UiButton
          size="small"
          :variant="localSelected.length === 0 ? 'primary' : 'primary-stroke'"
          class="ui-select-modal__quick-filter"
          @click="toggleQuickFilter(null)"
        >
          All
        </UiButton>
        <UiButton
          v-for="filter in quickFilters"
          :key="filter.value"
          size="small"
          :variant="activeQuickFilterValue === filter.value ? 'primary' : 'primary-stroke'"
          class="ui-select-modal__quick-filter"
          :data-value="filter.value"
          @click="toggleQuickFilter(filter.value)"
        >
          {{ filter.label }}
        </UiButton>
      </div>
      <div class="ui-select-modal__list">
        <div
          v-for="opt in filteredOptions"
          :key="opt.value"
          class="ui-select-modal__row"
          data-id="select-modal-option"
          :data-key="opt.value"
          data-field="option"
          :data-value="opt.value"
          @click="toggleOption(opt)"
        >
          <div class="ui-select-modal__asset">
            <slot
              name="icon"
              :option="opt"
            >
              <div
                v-if="opt.icon"
                class="ui-select-modal__asset-icon"
              >
                <img
                  :src="opt.icon"
                  alt="Asset icon"
                  @error="opt.iconFallback && opt.icon !== opt.iconFallback ? (opt.icon = opt.iconFallback) : (opt.icon = '')"
                >
              </div>
              <div
                v-else-if="opt.iconName"
                class="ui-select-modal__asset-symbol"
              >
                <UiIcon :name="opt.iconName" />
              </div>
              <div
                v-else
                class="ui-select-modal__asset-fallback"
              >
                {{ opt.label.charAt(0) }}
              </div>
            </slot>
            <span class="ui-select-modal__label">{{ opt.label }}</span>
          </div>
          <UiCheckbox
            :model-value="isOptionSelected(opt)"
            class="ui-select-modal__checkbox"
            @update:model-value="() => toggleOption(opt)"
          />
        </div>
      </div>
      <UiButton
        class="mb-12"
        variant="primary"
        size="xlarge"
        @click="save"
      >
        Save changes
      </UiButton>
      <UiButton
        v-if="!quickFilters?.length"
        variant="primary-stroke"
        size="xlarge"
        @click="clear"
      >
        Clear all
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>

<style lang="scss">
.ui-select-modal {
  &__content {
    display: flex;
    flex-direction: column;
  }

  &__list {
    display: flex;
    flex-direction: column;
    max-height: 300px;
    min-height: 300px;
    overflow-y: auto;
    margin-bottom: 12px;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  &__quick-filters {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 12px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--line-default);
  }

  &__quick-filter {
    flex-shrink: 0;
  }

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    cursor: pointer;
    border-radius: 8px;
  }

  &__asset {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__asset-icon {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--bg-surface);
    display: flex;
    align-items: center;
    justify-content: center;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }

  &__asset-fallback {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--accent-500);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 16px;
  }

  &__asset-symbol {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--bg-surface-secondary);
    border: 1px solid var(--line-default);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;

    svg {
      width: 16px;
      height: 16px;
    }
  }

  &__label {
    font-size: 16px;
    color: var(--text-primary);
  }

  &__checkbox {
    margin-right: 6px;
  }
}
</style>
