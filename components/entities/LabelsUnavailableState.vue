<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  description: string
  icon?: string
}>(), {
  icon: 'warning-circle',
})

const { isLoading, retryLabels } = useEulerLabels()
</script>

<template>
  <UiEmptyState
    :title="title"
    :description="description"
    :icon="icon"
  >
    <template #action>
      <UiButton
        variant="primary-stroke"
        size="small"
        :disabled="isLoading"
        @click="retryLabels"
      >
        {{ isLoading ? 'Retrying…' : 'Try again' }}
      </UiButton>
    </template>
  </UiEmptyState>
</template>
