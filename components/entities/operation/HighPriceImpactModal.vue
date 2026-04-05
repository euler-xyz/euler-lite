<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'

const props = defineProps<{
  directPriceImpact: number
  multipliedPriceImpact?: number | null
  onConfirm: () => void | Promise<void>
}>()
const emits = defineEmits(['close'])

const confirmText = ref('')
const isSubmitting = ref(false)
const isConfirmed = computed(() => confirmText.value.trim().toLowerCase() === 'i understand')

const onCancel = () => {
  emits('close')
}

const onSubmit = async () => {
  if (!isConfirmed.value || isSubmitting.value) return
  isSubmitting.value = true
  try {
    await props.onConfirm()
  }
  finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <BaseModalWrapper
    warning
    title="High Price Impact"
    @close="onCancel"
  >
    <div class="flex flex-col gap-24 flex-grow">
      <div class="text-p3 text-content-secondary">
        This transaction has a very high price impact. You may receive significantly less value than expected.
      </div>

      <div class="bg-surface-secondary rounded-12 p-16 flex flex-col gap-8">
        <div class="flex justify-between">
          <span class="text-p3 text-content-tertiary">Price impact</span>
          <span class="text-p2 text-error-500">{{ formatNumber(directPriceImpact, 2, 2) }}%</span>
        </div>
        <div
          v-if="multipliedPriceImpact !== undefined && multipliedPriceImpact !== null"
          class="flex justify-between"
        >
          <span class="text-p3 text-content-tertiary">Multiplied price impact</span>
          <span class="text-p2 text-error-500">{{ formatNumber(multipliedPriceImpact, 2, 2) }}%</span>
        </div>
      </div>

      <div class="flex flex-col gap-8">
        <label
          for="confirm-input"
          class="text-p3 text-content-secondary"
        >
          Type "I understand" to continue
        </label>
        <UiInput
          id="confirm-input"
          v-model="confirmText"
          placeholder="I understand"
          autocomplete="off"
          @keydown.enter="onSubmit"
        />
      </div>

      <div class="flex gap-8">
        <UiButton
          variant="primary-stroke"
          size="xlarge"
          rounded
          @click="onCancel"
        >
          Cancel
        </UiButton>
        <UiButton
          variant="primary"
          size="xlarge"
          rounded
          :disabled="!isConfirmed || isSubmitting"
          @click="onSubmit"
        >
          Confirm
        </UiButton>
      </div>
    </div>
  </BaseModalWrapper>
</template>
