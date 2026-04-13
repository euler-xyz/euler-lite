<script setup lang="ts">
import type { ToastVariant, ToastSize } from './toast.types'

export type { ToastVariant, ToastSize }

const props = withDefaults(defineProps<{
  variant?: ToastVariant
  size?: ToastSize
  title: string
  description?: string
  actionText?: string
  persistent?: boolean
  duration?: number
}>(), {
  variant: 'info',
  size: 'normal',
  persistent: true,
  duration: 5000,
})

const emit = defineEmits(['close', 'action'])

const hasAction = computed(() => !!props.actionText)

const iconName = computed(() => {
  const iconMap: Record<ToastVariant, string> = {
    info: 'info-circle',
    success: 'check-circle',
    warning: 'info-circle',
    error: 'warning-circle',
    neutral: 'info-circle',
  }
  return iconMap[props.variant]
})

const classes = computed(() => {
  return {
    [`ui-toast--${props.variant}`]: props.variant,
    [`ui-toast--${props.size}`]: props.size,
    'ui-toast--with-action': hasAction.value,
  }
})

// Auto-dismiss functionality
if (!props.persistent && props.duration > 0) {
  setTimeout(() => {
    emit('close')
  }, props.duration)
}
</script>

<template>
  <Transition
    name="toast"
    appear
  >
    <div
      :class="classes"
      class="ui-toast"
    >
      <div class="ui-toast__body">
        <UiIcon
          :name="iconName"
          class="ui-toast__icon"
        />
        <div class="ui-toast__content">
          <p
            v-if="title"
            class="ui-toast__title"
          >
            {{ title }}
          </p>
          <p
            v-if="description"
            class="ui-toast__description"
          >
            {{ description }}
          </p>
        </div>
        <button
          v-if="!persistent"
          class="ui-toast__close"
          @click="$emit('close')"
        >
          <UiIcon
            name="close"
            class="ui-toast__close-icon"
          />
        </button>
      </div>
      <div
        v-if="hasAction"
        class="ui-toast__action"
      >
        <button
          class="ui-toast__action-button"
          @click="$emit('action')"
        >
          <span>{{ actionText }}</span>
          <UiIcon
            name="arrow-right"
            class="ui-toast__action-icon"
          />
        </button>
      </div>
    </div>
  </Transition>
</template>

<style lang="scss">
.ui-toast {
  display: flex;
  flex-direction: column;
  width: 100%;
  border-radius: var(--radius-xl);
  border: 1px solid;
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(20px);
  overflow: hidden;

  // Variant colors
  &--info {
    border-color: var(--ui-toast-info-border-color);
    background: var(--ui-toast-info-background-color);
    color: var(--ui-toast-info-text-color);
  }

  &--success {
    border-color: var(--ui-toast-success-border-color);
    background: var(--ui-toast-success-background-color);
    color: var(--ui-toast-success-text-color);
  }

  &--warning {
    border-color: var(--ui-toast-warning-border-color);
    background: var(--ui-toast-warning-background-color);
    color: var(--ui-toast-warning-text-color);
  }

  &--error {
    border-color: var(--ui-toast-error-border-color);
    background: var(--ui-toast-error-background-color);
    color: var(--ui-toast-error-text-color);
  }

  &--neutral {
    border-color: var(--ui-toast-neutral-border-color);
    background: var(--ui-toast-neutral-background-color);
    color: var(--ui-toast-neutral-text-color);
  }

  // Size variants
  &--normal {
    .ui-toast__body {
      padding: 16px;
      gap: 12px;
    }

    .ui-toast__title {
      font-size: 14px;
      line-height: 20px;
      font-weight: 600;
    }

    .ui-toast__description {
      font-size: 14px;
      line-height: 20px;
    }

    .ui-toast__icon {
      width: 20px;
      height: 20px;
    }

    .ui-toast__action {
      padding: 12px 16px;
    }
  }

  &--compact {
    .ui-toast__body {
      padding: 12px;
      gap: 8px;
    }

    .ui-toast__content {
      gap: 2px;
    }

    .ui-toast__title {
      font-size: 12px;
      line-height: 16px;
      font-weight: 600;
    }

    .ui-toast__description {
      font-size: 12px;
      line-height: 16px;
    }

    .ui-toast__icon {
      width: 16px;
      height: 16px;
    }

    .ui-toast__action {
      padding: 8px 12px;
    }

    .ui-toast__action-icon {
      width: 14px;
      height: 14px;
    }
  }

  // Structure
  &__body {
    display: flex;
    align-items: center;
  }

  &__icon {
    flex-shrink: 0;
  }

  &__content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  &__title,
  &__description {
    margin: 0;
    text-align: left;
  }

  &__description {
    opacity: 0.8;
  }

  &__close {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: currentColor;
    opacity: 0.5;
    transition: opacity var(--duration-fast) var(--ease-default);

    &:hover {
      opacity: 1;
    }
  }

  &__close-icon {
    width: 14px;
    height: 14px;
  }

  &__action {
    display: flex;
    align-items: center;
    border-top: 1px solid currentColor;
    border-top-color: inherit;
    opacity: 0.8;
  }

  &__action-button {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    color: currentColor;
    font-size: inherit;
    font-weight: 600;
    transition: opacity var(--duration-fast) var(--ease-default);

    &:hover {
      opacity: 0.7;
    }
  }

  &__action-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
}
</style>
