<script setup lang="ts">
const emits = defineEmits(['close'])
const { cancelAction, acceptAction } = defineProps<{
  cancelAction?: () => void
  acceptAction?: () => void
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
    title="Important!"
    warning
    @close="handleCancel"
  >
    <div class="flex flex-col gap-12 text-content-primary mb-24">
      <h4 class="text-white text-h4">
        Are you sure you want to interact with the unverified vault?
      </h4>
      <p class="pb-8">
        Proceeding with this unknown and unverified vault may pose security risks. Such vaults could potentially be used for phishing attempts.
      </p>
      <p>
        Please ensure you trust the source before continuing.
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
