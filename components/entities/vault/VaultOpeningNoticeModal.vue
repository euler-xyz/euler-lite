<script setup lang="ts">
import { FLAGGED_VAULT_TITLE } from '~/utils/vault-assessment/flagged'

const emits = defineEmits(['close'])
const { cancelAction, acceptAction, flaggedText } = defineProps<{
  cancelAction?: () => void
  acceptAction?: () => void
  flaggedText?: string | null
}>()

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
    :title="flaggedText ? FLAGGED_VAULT_TITLE : 'Important!'"
    warning
    @close="handleCancel"
  >
    <p class="text-content-primary mb-24">
      {{ flaggedText || 'Are you sure you want to interact with this unknown vault? It may pose security risks and could be used for phishing. Make sure you trust the source before you continue.' }}
    </p>
    <div class="flex gap-8">
      <UiButton
        size="large"
        rounded
        variant="primary-stroke"
        @click="handleAccept"
      >
        {{ flaggedText ? 'Continue' : 'Yes' }}
      </UiButton>
      <UiButton
        size="large"
        rounded
        @click="handleCancel"
      >
        {{ flaggedText ? 'Go back' : 'Cancel' }}
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
