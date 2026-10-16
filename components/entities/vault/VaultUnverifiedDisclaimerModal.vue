<script setup lang="ts">
import { getUnverifiedActionCopy } from '~/utils/vault-assessment/presentation'

const emits = defineEmits(['close'])
const { cancelAction, acceptAction, unlistedNotice } = defineProps<{
  cancelAction?: () => void
  acceptAction?: () => void
  unlistedNotice?: string | null
}>()
const actionCopy = computed(() => getUnverifiedActionCopy(unlistedNotice))

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
    title="Important!"
    warning
    @close="handleCancel"
  >
    <div class="flex flex-col gap-12 text-content-primary mb-24">
      <h4 class="text-white text-h4">
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
        Yes
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
