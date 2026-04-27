<script setup lang="ts">
import { DEFAULT_SLIPPAGE, HIGH_SLIPPAGE_THRESHOLD } from '~/entities/constants'
import { formatNumber } from '~/utils/string-utils'

const _props = withDefaults(defineProps<{
  deferSave?: boolean
}>(), {
  deferSave: false,
})

const { slippage, setSlippage, minSlippage, maxSlippage, defaultSlippage, isOverrideActive } = useSlippage()

const slippagePresets = [
  { label: '0.1%', value: 0.1 },
  { label: '0.3%', value: 0.3 },
  { label: '0.5%', value: 0.5 },
]

const presetValues = slippagePresets.map(option => option.value)
const isCustomInputVisible = ref(false)
const customInput = ref('')
const customInputError = ref('')
const slippageSelection = useLocalStorage<'preset' | 'custom'>('swap-slippage-selection', 'preset')

// Reset selection state when override expires back to a default (preset or stablecoin)
if (!isOverrideActive.value && (presetValues.includes(slippage.value) || slippage.value === defaultSlippage.value)) {
  slippageSelection.value = 'preset'
}

const isCustomSelected = computed(() => slippageSelection.value === 'custom')
const isCustomValue = computed(() => !presetValues.includes(slippage.value) && slippage.value !== defaultSlippage.value)
const customChipActive = computed(() => isCustomInputVisible.value || isCustomSelected.value || isCustomValue.value)
const customChipValue = computed(() => `${formatNumber(slippage.value, 2, 0)}%`)

const isHighSlippage = computed(() => slippage.value > HIGH_SLIPPAGE_THRESHOLD)

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
  if (parsed > maxSlippage) {
    return null
  }
  return Math.max(minSlippage, parsed)
}

const parsedCustomSlippage = computed(() => parseCustomSlippage(customInput.value))

const rawCustomValue = computed(() => {
  const normalized = String(customInput.value ?? '').replace(/%/g, '').replace(',', '.').trim()
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : null
})

const isInputOverMax = computed(() => {
  return rawCustomValue.value !== null && rawCustomValue.value > maxSlippage
})

const isInputHighSlippage = computed(() => {
  const parsed = parsedCustomSlippage.value
  return parsed !== null && parsed > HIGH_SLIPPAGE_THRESHOLD
})

const onSaveCustom = () => {
  const parsed = parsedCustomSlippage.value
  if (parsed === null) {
    customInputError.value = `Enter a value between ${minSlippage}% and ${maxSlippage}%`
    return
  }
  customInputError.value = ''
  setSlippage(parsed)
  slippageSelection.value = 'custom'
  isCustomInputVisible.value = false
}

watch(slippage, (value) => {
  if (slippageSelection.value === 'preset' && !presetValues.includes(value) && value !== defaultSlippage.value) {
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

const savePending = (): boolean => {
  if (!isCustomInputVisible.value) return true
  const parsed = parsedCustomSlippage.value
  if (parsed === null) {
    customInputError.value = `Enter a value between ${minSlippage}% and ${maxSlippage}%`
    return false
  }
  customInputError.value = ''
  setSlippage(parsed)
  slippageSelection.value = 'custom'
  isCustomInputVisible.value = false
  return true
}

defineExpose({ savePending })
</script>

<template>
  <div class="mb-20 rounded-16 border border-line-default bg-card p-16">
    <div class="flex flex-col gap-8">
      <div class="text-p2">
        Slippage settings
      </div>
      <div class="text-p3 text-content-muted">
        <template v-if="isOverrideActive && slippage > DEFAULT_SLIPPAGE">
          Custom slippage (resets to {{ defaultSlippage }}% default after 24h)
        </template>
        <template v-else-if="defaultSlippage !== DEFAULT_SLIPPAGE">
          Default: {{ defaultSlippage }}% for stablecoin swaps
        </template>
        <template v-else>
          Default slippage for swaps is {{ defaultSlippage }}%
        </template>
      </div>
      <div class="flex flex-wrap gap-8 rounded-[32px] bg-surface-secondary p-6">
        <button
          v-for="option in slippagePresets"
          :key="option.value"
          type="button"
          :class="['slippage-settings__chip', { 'slippage-settings__chip--active': isPresetActive(option.value) }]"
          @click="onPresetSelect(option.value)"
        >
          {{ option.label }}
        </button>
        <button
          type="button"
          :class="['slippage-settings__chip', { 'slippage-settings__chip--active': customChipActive }]"
          @click="onCustomChipClick"
        >
          <span v-if="isCustomSelected && !isCustomInputVisible">
            Custom
            <span class="text-content-primary font-semibold">{{ customChipValue }}</span>
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
          v-if="!deferSave"
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
      <div
        v-else-if="isCustomInputVisible && isInputOverMax"
        class="text-p4 text-red-500"
      >
        Maximum slippage is {{ maxSlippage }}%
      </div>
      <div
        v-else-if="isCustomInputVisible && isInputHighSlippage"
        class="text-p4 text-warning-500"
      >
        High slippage may result in significant losses
      </div>
      <div
        v-else-if="!isCustomInputVisible && isHighSlippage"
        class="text-p4 text-warning-500"
      >
        Slippage is set to {{ formatNumber(slippage, 2, 0) }}%. This may result in significant losses.
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.slippage-settings__chip {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  gap: 8px;
  padding: 6px 14px;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 100px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  box-shadow: var(--ui-input-shadow);

  &:hover {
    color: var(--accent-600);
    border-color: var(--border-emphasis);
    background: var(--bg-surface-elevated);
  }

  &--active {
    font-weight: 600;
    color: var(--ui-select-chip-active-color);
    background: var(--ui-select-chip-active-background-color);
    border-color: transparent;
    box-shadow: var(--accent-shadow-md);

    &:hover {
      color: var(--ui-select-chip-active-color);
      background: var(--accent-600);
      border-color: transparent;
      box-shadow: var(--accent-shadow-lg);
    }
  }
}
</style>
