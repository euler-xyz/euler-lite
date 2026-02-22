<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'

const { slippage, setSlippage, minSlippage, maxSlippage } = useSlippage()

const slippagePresets = [
  { label: '0.1%', value: 0.1 },
  { label: '0.5%', value: 0.5 },
  { label: '1%', value: 1 },
]

const presetValues = slippagePresets.map(option => option.value)
const isCustomInputVisible = ref(false)
const customInput = ref('')
const customInputError = ref('')
const slippageSelection = useLocalStorage<'preset' | 'custom'>('swap-slippage-selection', 'preset')

const isCustomSelected = computed(() => slippageSelection.value === 'custom')
const isCustomValue = computed(() => !presetValues.includes(slippage.value))
const customChipActive = computed(() => isCustomInputVisible.value || isCustomSelected.value || isCustomValue.value)
const customChipValue = computed(() => `${formatNumber(slippage.value, 2, 0)}%`)

const onPresetSelect = (value: number) => {
  isCustomInputVisible.value = false
  slippageSelection.value = 'preset'
  setSlippage(value)
}

const onCustomChipClick = () => {
  isCustomInputVisible.value = true
  slippageSelection.value = 'custom'
  customInput.value = String(slippage.value)
}

const parseCustomSlippage = (value: string | number | null | undefined) => {
  const normalized = String(value ?? '').replace(/%/g, '').replace(',', '.').trim()
  const parsed = Number.parseFloat(normalized)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.min(maxSlippage, Math.max(minSlippage, parsed))
}

const parsedCustomSlippage = computed(() => parseCustomSlippage(customInput.value))

const onSaveCustom = () => {
  const parsed = parsedCustomSlippage.value
  if (parsed === null) {
    customInputError.value = `Enter a value between ${minSlippage} and ${maxSlippage}`
    return
  }
  customInputError.value = ''
  setSlippage(parsed)
  slippageSelection.value = 'custom'
  isCustomInputVisible.value = false
}

watch(slippage, (value) => {
  if (slippageSelection.value === 'preset' && !presetValues.includes(value)) {
    slippageSelection.value = 'custom'
  }
})

const isPresetActive = (value: number) => {
  if (isCustomInputVisible.value || slippageSelection.value !== 'preset') {
    return false
  }
  return slippage.value === value
}

watch(customInput, () => {
  if (customInputError.value) {
    customInputError.value = ''
  }
})
</script>

<template>
  <div class="py-16">
    <div class="flex flex-col gap-8">
      <div class="text-p2">
        Slippage settings
      </div>
      <div class="text-p3 text-euler-dark-700">
        Default slippage for swaps
      </div>
      <div class="flex flex-wrap gap-8 rounded-6 bg-euler-dark-600 p-6">
        <button
          v-for="option in slippagePresets"
          :key="option.value"
          type="button"
          :class="['ui-select__chip', { 'ui-select__chip--active': isPresetActive(option.value) }]"
          @click="onPresetSelect(option.value)"
        >
          {{ option.label }}
        </button>
        <button
          type="button"
          :class="['ui-select__chip', { 'ui-select__chip--active': customChipActive }]"
          @click="onCustomChipClick"
        >
          <span v-if="isCustomSelected && !isCustomInputVisible">
            Custom
            <span class="text-euler-dark-500 font-semibold">{{ customChipValue }}</span>
          </span>
          <span v-else>
            Set custom
          </span>
        </button>
      </div>
      <div
        v-if="isCustomInputVisible"
        class="flex items-center gap-8"
      >
        <UiInput
          v-model="customInput"
          class="flex-1"
          type="text"
          input-mode="decimal"
          placeholder="Custom slippage"
          :error="Boolean(customInputError)"
          @keyup.enter="onSaveCustom"
        />
        <UiButton
          size="medium"
          @click="onSaveCustom"
        >
          Save
        </UiButton>
      </div>
      <div
        v-if="customInputError"
        class="text-p4 text-red-500"
      >
        {{ customInputError }}
      </div>
    </div>
  </div>
</template>
