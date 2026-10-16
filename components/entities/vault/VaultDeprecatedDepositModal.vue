<script setup lang="ts">
const emit = defineEmits<{ close: [] }>()
defineProps<{ reason: string | null, acceptAction: () => void }>()

const accept = () => {
  emit('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Deprecated vault"
    warning
    @close="emit('close')"
  >
    <div class="flex flex-col gap-12 text-content-primary mb-24">
      <p>This vault is deprecated. Review its status before depositing more funds.</p>
      <p v-if="reason">
        {{ reason }}
      </p>
    </div>
    <div class="flex gap-8">
      <UiButton
        size="large"
        rounded
        variant="primary-stroke"
        @click="emit('close')"
      >
        Cancel
      </UiButton>
      <UiButton
        size="large"
        rounded
        @click="acceptAction(); accept()"
      >
        I understand
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
