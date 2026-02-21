<script setup lang="ts">
type Option = { label: string, value: string, icon?: string, iconFallback?: string }

const props = defineProps<{
  selectedA: string[]
  selectedB: string[]
  optionsA: Option[]
  optionsB: Option[]
  labelA: string
  labelB: string
  onSave?: (selectedA: string[], selectedB: string[]) => void
}>()

const emit = defineEmits(['close'])

const activeTab = ref<'a' | 'b'>('a')
const localSelectedA = ref<string[]>([...props.selectedA])
const localSelectedB = ref<string[]>([...props.selectedB])
const searchModel = ref('')

const activeOptions = computed(() => activeTab.value === 'a' ? props.optionsA : props.optionsB)
const activeSelected = computed(() => activeTab.value === 'a' ? localSelectedA.value : localSelectedB.value)

const filteredOptions = computed(() => {
  return searchModel.value
    ? activeOptions.value.filter(o =>
        o.label.replace('₮', 'T').toLowerCase().includes(searchModel.value.toLowerCase()),
      )
    : activeOptions.value
})

const switchTab = (tab: 'a' | 'b') => {
  activeTab.value = tab
  searchModel.value = ''
}

const toggleOption = (value: string) => {
  const list = activeTab.value === 'a' ? localSelectedA : localSelectedB
  const idx = list.value.indexOf(value)
  if (idx > -1) list.value.splice(idx, 1)
  else list.value.push(value)
}

const save = () => {
  props.onSave?.(localSelectedA.value, localSelectedB.value)
  emit('close')
}

const clear = () => {
  localSelectedA.value = []
  localSelectedB.value = []
  props.onSave?.([], [])
  emit('close')
}
</script>

<template>
  <BaseModalWrapper
    class="ui-select-modal"
    :title="activeTab === 'a' ? labelA : labelB"
    :full="false"
    @close="emit('close')"
  >
    <div class="ui-select-modal__content">
      <!-- Tab switcher -->
      <div class="flex gap-8 mb-16">
        <button
          class="flex-1 py-8 text-[13px] font-medium border-b-2 transition-all"
          :class="activeTab === 'a'
            ? 'border-accent-500 text-content-primary'
            : 'border-transparent text-content-tertiary hover:text-content-secondary'"
          @click="switchTab('a')"
        >
          {{ labelA }}
          <span
            v-if="localSelectedA.length"
            class="ml-4 text-accent-600"
          >{{ localSelectedA.length }}</span>
        </button>
        <button
          class="flex-1 py-8 text-[13px] font-medium border-b-2 transition-all"
          :class="activeTab === 'b'
            ? 'border-accent-500 text-content-primary'
            : 'border-transparent text-content-tertiary hover:text-content-secondary'"
          @click="switchTab('b')"
        >
          {{ labelB }}
          <span
            v-if="localSelectedB.length"
            class="ml-4 text-accent-600"
          >{{ localSelectedB.length }}</span>
        </button>
      </div>

      <UiInput
        v-model="searchModel"
        placeholder="Search asset"
        class="mb-16"
        icon="search"
      />

      <div class="ui-select-modal__list">
        <div
          v-for="opt in filteredOptions"
          :key="opt.value"
          class="ui-select-modal__row"
          @click="toggleOption(opt.value)"
        >
          <div class="ui-select-modal__asset">
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
            <span class="ui-select-modal__label">{{ opt.label }}</span>
          </div>
          <UiCheckbox
            :model-value="activeSelected.includes(opt.value)"
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
