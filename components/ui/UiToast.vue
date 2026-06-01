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
    success: 'check',
    warning: 'warning',
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
          type="button"
          class="ui-toast__close"
          aria-label="Close notification"
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
          type="button"
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
  align-items: stretch;
  width: 100%;
  min-width: min(220px, 100%);
  color: var(--ui-toast-neutral-text-color);
  background-color: var(--ui-toast-background-color);
  border: 1px solid var(--ui-toast-neutral-border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--ui-toast-box-shadow);
  overflow: hidden;

  &--info {
    .ui-toast__icon {
      color: var(--ui-toast-info-text-color);
    }
  }

  &--success {
    .ui-toast__icon {
      color: var(--ui-toast-success-text-color);
    }
  }

  &--warning {
    .ui-toast__icon {
      color: var(--ui-toast-warning-text-color);
    }
  }

  &--error {
    .ui-toast__icon {
      color: var(--ui-toast-error-text-color);
    }
  }

  &--neutral {
    .ui-toast__icon {
      color: var(--text-tertiary);
    }
  }

  &--normal {
    .ui-toast__body {
      padding: 12px 14px;
      gap: 10px;
    }

    .ui-toast__title {
      font-size: 14px;
      line-height: 20px;
      font-weight: 600;
    }

    .ui-toast__description {
      font-size: 13px;
      line-height: 18px;
    }

    .ui-toast__icon {
      width: 18px;
      height: 18px;
    }

    .ui-toast__action {
      padding: 0 14px 12px 42px;
    }

    .ui-toast__action-button {
      font-size: 13px;
      line-height: 18px;
    }
  }

  &--compact {
    .ui-toast__body {
      padding: 12px 14px;
      gap: 10px;
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
      padding: 0 14px 12px 40px;
    }

    .ui-toast__action-button {
      font-size: 12px;
      line-height: 16px;
    }

    .ui-toast__action-icon {
      width: 14px;
      height: 14px;
    }
  }

  &__body {
    display: flex;
    align-items: flex-start;
    width: 100%;
  }

  &__icon {
    flex-shrink: 0;
    margin-top: 1px;
  }

  &__content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    gap: 2px;
  }

  &__title,
  &__description {
    margin: 0;
    text-align: left;
  }

  &__title {
    color: var(--text-primary);
  }

  &__description {
    color: var(--text-secondary);
  }

  &__close {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text-tertiary);
    transition: background-color var(--trs-fast), color var(--trs-fast);

    &:hover {
      color: var(--text-primary);
      background-color: var(--ui-button-secondary-ghost-hover-background-color);
    }

    &:focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }
  }

  &__close-icon {
    width: 16px;
    height: 16px;
  }

  &__action {
    display: flex;
    align-items: center;
  }

  &__action-button {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    padding: 0;
    color: var(--text-accent);
    font-size: inherit;
    font-weight: 600;
    line-height: inherit;
    transition: background-color var(--trs-fast), color var(--trs-fast);

    &:hover {
      color: var(--text-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }
  }

  &__action-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
}
</style>
