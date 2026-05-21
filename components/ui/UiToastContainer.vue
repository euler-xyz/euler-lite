<script setup lang="ts">
import type { Toast } from './toast.types'
import { registerToastContainer, unregisterToastContainer } from '~/components/ui/composables/useToast'

export type { Toast }

const toasts = ref<Toast[]>([])

const addToast = (toast: Omit<Toast, 'id'>) => {
  const id = Date.now().toString()
  const newToast: Toast = {
    id,
    variant: 'info',
    size: 'normal',
    persistent: false,
    duration: 5000,
    ...toast,
  }
  toasts.value.push(newToast)
  return id
}

const removeToast = (id: string) => {
  const index = toasts.value.findIndex(toast => toast.id === id)
  if (index > -1) {
    toasts.value.splice(index, 1)
  }
}

const clearAllToasts = () => {
  toasts.value = []
}

const handleToastAction = (toast: Toast) => {
  if (toast.onAction) {
    toast.onAction()
  }
  if (!toast.persistent) {
    removeToast(toast.id)
  }
}

// Expose methods for external use
defineExpose({
  addToast,
  removeToast,
  clearAllToasts,
})

// Register this container instance
onMounted(() => {
  registerToastContainer({
    addToast,
    removeToast,
    clearAllToasts,
  })
})

// Unregister on unmount
onUnmounted(() => {
  unregisterToastContainer()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="toasts.length > 0"
      class="ui-toast-container"
    >
      <TransitionGroup
        name="toast-list"
        tag="div"
        class="ui-toast-container__list"
      >
        <UiToast
          v-for="toast in toasts"
          :key="toast.id"
          :variant="toast.variant"
          :size="toast.size"
          :title="toast.title"
          :description="toast.description"
          :action-text="toast.actionText"
          :persistent="toast.persistent"
          :duration="toast.duration"
          class="ui-toast-container__toast"
          @close="removeToast(toast.id)"
          @action="handleToastAction(toast)"
        />
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style lang="scss">
.ui-toast-container {
  position: fixed;
  top: 24px;
  right: 24px;
  z-index: 9999;
  pointer-events: none;

  @media (max-width: 768px) {
    top: 16px;
    right: 16px;
    left: 16px;
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 360px;

    @media (max-width: 768px) {
      max-width: none;
    }
  }

  &__toast {
    pointer-events: auto;
  }
}
</style>
