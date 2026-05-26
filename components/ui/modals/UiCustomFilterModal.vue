<script setup lang="ts">
import type { CustomFilter, FilterMetricOption, FilterMetricUnit } from './customFilter.types'
import { formatCompactUsdValue } from '~/utils/string-utils'

export type { CustomFilter, FilterMetricOption, FilterMetricUnit }

const props = defineProps<{
  metrics: FilterMetricOption[]
  onAdd?: (filter: CustomFilter) => void
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const MAX_FILTER_VALUE = 1e15

let filterIdCounter = 0

const selectedMetric = ref(props.metrics[0]?.key ?? '')
const selectedOperator = ref<'gt' | 'lt'>('gt')
const valueInput = ref('')

const selectedMetricOption = computed(() =>
  props.metrics.find(m => m.key === selectedMetric.value) ?? props.metrics[0],
)

const unitLabel = computed(() => {
  switch (selectedMetricOption.value?.unit) {
    case 'percent': return '%'
    case 'multiplier': return 'x'
    default: return 'USD'
  }
})

const inputPlaceholder = computed(() => {
  switch (selectedMetricOption.value?.unit) {
    case 'percent': return 'e.g. 5 or -2'
    case 'multiplier': return 'e.g. 3'
    default: return 'e.g. 1000000'
  }
})

const sanitizeNumericInput = (raw: string, allowNegative: boolean): number | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const pattern = allowNegative ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/
  if (!pattern.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  if (!allowNegative && parsed <= 0) return null
  if (Math.abs(parsed) > MAX_FILTER_VALUE) return null
  return parsed
}

const allowsNegative = computed(() => {
  const unit = selectedMetricOption.value?.unit
  return unit === 'percent' || unit === 'multiplier'
})

const numericValue = computed(() => sanitizeNumericInput(valueInput.value, allowsNegative.value))

const isValid = computed(() => numericValue.value !== null)

const formatValue = (value: number, unit: FilterMetricUnit): string => {
  switch (unit) {
    case 'percent': return `${value}%`
    case 'multiplier': return `${value}x`
    default: return formatCompactUsdValue(value)
  }
}

const addFilter = () => {
  if (numericValue.value === null || !selectedMetricOption.value) return

  const { shortLabel, unit } = selectedMetricOption.value
  const op = selectedOperator.value === 'gt' ? '>' : '<'

  const filter: CustomFilter = {
    id: `cf-${Date.now()}-${++filterIdCounter}`,
    metric: selectedMetric.value,
    operator: selectedOperator.value,
    value: numericValue.value,
    label: `${shortLabel} ${op} ${formatValue(numericValue.value, unit)}`,
  }

  props.onAdd?.(filter)
  emit('close')
}

const close = () => {
  emit('close')
}
</script>

<template>
  <BaseModalWrapper
    class="custom-filter-modal"
    data-id="custom-filter-modal"
    title="Add filter"
    @close="close"
  >
    <div class="flex flex-col gap-16">
      <!-- Metric selector -->
      <div class="flex flex-col gap-8">
        <span class="text-[13px] font-medium text-content-tertiary uppercase tracking-wider">
          Metric
        </span>
        <div class="flex flex-col gap-2">
          <button
            v-for="option in metrics"
            :key="option.key"
            type="button"
            class="custom-filter-modal__metric-row"
            data-id="custom-filter-metric"
            :data-key="option.key"
            data-field="metric"
            :data-value="option.label"
            :class="{ 'custom-filter-modal__metric-row--active': selectedMetric === option.key }"
            @click="selectedMetric = option.key"
          >
            <span>{{ option.label }}</span>
            <span class="text-[12px] text-content-tertiary">{{ option.unit === 'percent' ? '%' : option.unit === 'multiplier' ? 'x' : 'USD' }}</span>
          </button>
        </div>
      </div>

      <!-- Operator toggle -->
      <div class="flex flex-col gap-8">
        <span class="text-[13px] font-medium text-content-tertiary uppercase tracking-wider">
          Condition
        </span>
        <div class="flex gap-8">
          <button
            class="custom-filter-modal__operator-btn"
            data-id="custom-filter-operator"
            data-key="gt"
            data-field="operator"
            data-value="Greater than"
            :class="{ 'custom-filter-modal__operator-btn--active': selectedOperator === 'gt' }"
            @click="selectedOperator = 'gt'"
          >
            Greater than
          </button>
          <button
            class="custom-filter-modal__operator-btn"
            data-id="custom-filter-operator"
            data-key="lt"
            data-field="operator"
            data-value="Less than"
            :class="{ 'custom-filter-modal__operator-btn--active': selectedOperator === 'lt' }"
            @click="selectedOperator = 'lt'"
          >
            Less than
          </button>
        </div>
      </div>

      <!-- Value input -->
      <div class="flex flex-col gap-8">
        <span class="text-[13px] font-medium text-content-tertiary uppercase tracking-wider">
          Value ({{ unitLabel }})
        </span>
        <UiInput
          v-model="valueInput"
          :placeholder="inputPlaceholder"
          input-mode="decimal"
        />
      </div>

      <!-- Add button -->
      <UiButton
        variant="primary"
        size="xlarge"
        :disabled="!isValid"
        @click="addFilter"
      >
        Add filter
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>

<style lang="scss">
.custom-filter-modal {
  &__metric-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 12px 16px;
    border: none;
    background: none;
    text-align: left;
    border-radius: 10px;
    cursor: pointer;
    font-size: 15px;
    color: var(--text-primary);
    transition: all 0.15s ease;

    &:hover {
      background: var(--neutral-50);
    }

    &--active {
      background: rgba(var(--accent-rgb), 0.15);
      color: var(--accent-700);
      font-weight: 600;

      &:hover {
        background: rgba(var(--accent-rgb), 0.2);
      }
    }
  }

  &__operator-btn {
    flex: 1;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 500;
    border-radius: 100px;
    cursor: pointer;
    transition: all 0.15s ease;
    background: var(--ui-select-field-background-color);
    border: 1px solid var(--neutral-300);
    color: var(--text-primary);

    &:hover {
      border-color: var(--neutral-400);
      background: var(--neutral-50);
    }

    &--active {
      background: var(--ui-select-chip-active-background-color);
      color: var(--ui-select-chip-active-color);
      border-color: transparent;
      font-weight: 600;

      &:hover {
        background: var(--accent-600);
        border-color: transparent;
      }
    }
  }
}
</style>
