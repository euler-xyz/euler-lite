<script setup lang="ts">
import type { SelectOption } from './select.types'

const props = defineProps<{
  selected: string[]
  options: SelectOption[]
  title?: string
  inputPlaceholder?: string
  onSave?: (selected: string[]) => void
}>()
const emit = defineEmits(['close'])

const localSelected = ref<string[]>([...props.selected])
const selectedPrioritySet = ref(new Set(props.selected))
const searchModel = ref('')

const filteredOptions = computed(() => {
  const options = searchModel.value
    ? props.options.filter((option) => {
        return option.label.replace('₮', 'T').toLowerCase().includes(searchModel.value.toLowerCase())
      })
    : props.options

  const selectedFirst: typeof props.options = []
  const unselected: typeof props.options = []
  options.forEach((option) => {
    if (selectedPrioritySet.value.has(option.value)) {
      selectedFirst.push(option)
      return
    }
    unselected.push(option)
  })
  return [...selectedFirst, ...unselected]
})

const toggleOption = (value: string) => {
  const idx = localSelected.value.indexOf(value)
  if (idx > -1) {
    localSelected.value.splice(idx, 1)
  }
  else {
    localSelected.value.push(value)
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
        class="mb-16"
        icon="search"
      />
      <div class="ui-select-modal__list">
        <div
          v-for="opt in filteredOptions"
          :key="opt.value"
          class="ui-select-modal__row"
          data-id="select-modal-option"
          :data-key="opt.value"
          data-field="option"
          :data-value="opt.label"
          @click="toggleOption(opt.value)"
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
                v-else
                class="ui-select-modal__asset-fallback"
              >
                {{ opt.label.charAt(0) }}
              </div>
            </slot>
            <span class="ui-select-modal__label">{{ opt.label }}</span>
          </div>
          <UiCheckbox
            :model-value="localSelected.includes(opt.value)"
            class="ui-select-modal__checkbox"
            @update:model-value="() => toggleOption(opt.value)"
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

  &__label {
    font-size: 16px;
    color: var(--text-primary);
  }

  &__checkbox {
    margin-right: 6px;
  }
}
</style>
