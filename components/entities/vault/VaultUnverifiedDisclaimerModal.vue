<script setup lang="ts">
import { getUnverifiedActionCopy } from '~/utils/vault-assessment/presentation'

const emits = defineEmits(['close'])
const { cancelAction, acceptAction, flaggedNotice } = defineProps<{
  cancelAction?: () => void
  acceptAction?: () => void
  flaggedNotice?: string | null
}>()
const actionCopy = computed(() => getUnverifiedActionCopy(flaggedNotice))

const handleAccept = () => {
  acceptAction?.()
  emits('close')
}

const handleCancel = () => {
  cancelAction?.()
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    :title="flaggedNotice ? actionCopy.title : 'Important!'"
    warning
    @close="handleCancel"
  >
    <div class="flex flex-col gap-12 text-content-primary mb-24">
      <h4
        v-if="!flaggedNotice"
        class="text-white text-h4"
      >
        {{ actionCopy.title }}
      </h4>
      <p class="pb-8">
        {{ actionCopy.description }}
      </p>
    </div>
    <div class="flex gap-8">
      <UiButton
        size="large"
        rounded
        variant="primary-stroke"
        @click="handleAccept"
      >
        {{ flaggedNotice ? 'Confirm' : 'Yes' }}
      </UiButton>
      <UiButton
        size="large"
        rounded
        @click="handleCancel"
      >
        Cancel
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
