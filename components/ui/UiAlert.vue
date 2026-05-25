<script setup lang="ts">
import type { ToastVariant, ToastSize } from './toast.types'

export type { ToastVariant, ToastSize }

const props = withDefaults(defineProps<{
  variant?: ToastVariant
  size?: ToastSize
  title: string
  description?: string
  actionText?: string
}>(), {
  variant: 'info',
  size: 'normal',
})

defineEmits(['action'])

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
    [`ui-alert--${props.variant}`]: props.variant,
    [`ui-alert--${props.size}`]: props.size,
    'ui-alert--with-action': hasAction.value,
  }
})
</script>

<template>
  <div
    :class="classes"
    class="ui-alert"
  >
    <div class="ui-alert__body">
      <UiIcon
        :name="iconName"
        class="ui-alert__icon"
      />
      <div class="ui-alert__content">
        <p
          v-if="title"
          class="ui-alert__title"
        >
          {{ title }}
        </p>
        <p
          v-if="description"
          class="ui-alert__description"
        >
          {{ description }}
        </p>
      </div>
    </div>
    <div
      v-if="hasAction"
      class="ui-alert__action"
    >
      <button
        type="button"
        class="ui-alert__action-button"
        @click="$emit('action')"
      >
        <span>{{ actionText }}</span>
        <UiIcon
          name="arrow-right"
          class="ui-alert__action-icon"
        />
      </button>
    </div>
  </div>
</template>

<style lang="scss">
.ui-alert {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  min-width: min(220px, 100%);
  border: 1px solid;
  border-radius: var(--radius-md);
  box-shadow: var(--ui-toast-box-shadow);
  overflow: hidden;

  &--info {
    color: var(--ui-toast-info-text-color);
    background-color: var(--ui-toast-info-background-color);
    border-color: var(--ui-toast-info-border-color);
  }

  &--success {
    color: var(--ui-toast-success-text-color);
    background-color: var(--ui-toast-success-background-color);
    border-color: var(--ui-toast-success-border-color);
  }

  &--warning {
    color: var(--ui-toast-warning-text-color);
    background-color: var(--ui-toast-warning-background-color);
    border-color: var(--ui-toast-warning-border-color);
  }

  &--error {
    color: var(--ui-toast-error-text-color);
    background-color: var(--ui-toast-error-background-color);
    border-color: var(--ui-toast-error-border-color);
  }

  &--neutral {
    color: var(--ui-toast-neutral-text-color);
    background-color: var(--ui-toast-neutral-background-color);
    border-color: var(--ui-toast-neutral-border-color);
  }

  &--normal {
    .ui-alert__body {
      padding: 12px 14px;
      gap: 10px;
    }

    .ui-alert__title {
      font-size: 14px;
      line-height: 20px;
      font-weight: 600;
    }

    .ui-alert__description {
      font-size: 13px;
      line-height: 18px;
    }

    .ui-alert__icon {
      width: 18px;
      height: 18px;
    }

    .ui-alert__action {
      padding: 0 14px 12px 42px;
    }

    .ui-alert__action-button {
      font-size: 13px;
      line-height: 18px;
    }
  }

  &--compact {
    .ui-alert__body {
      padding: 12px 14px;
      gap: 10px;
    }

    .ui-alert__content {
      gap: 2px;
    }

    .ui-alert__title {
      font-size: 12px;
      line-height: 16px;
      font-weight: 600;
    }

    .ui-alert__description {
      font-size: 12px;
      line-height: 16px;
    }

    .ui-alert__icon {
      width: 16px;
      height: 16px;
    }

    .ui-alert__action {
      padding: 0 14px 12px 40px;
    }

    .ui-alert__action-button {
      font-size: 12px;
      line-height: 16px;
    }

    .ui-alert__action-icon {
      width: 14px;
      height: 14px;
    }
  }

  &__body {
    display: flex;
    align-items: center;
    width: 100%;
  }

  &__icon {
    flex-shrink: 0;
  }

  &__content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    align-self: center;
    gap: 2px;
  }

  &__title,
  &__description,
  &__icon {
    color: currentColor;
  }

  &__title,
  &__description {
    margin: 0;
    text-align: left;
  }

  &__description {
    opacity: 0.8;
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
    color: currentColor;
    font-size: inherit;
    font-weight: 600;
    line-height: inherit;
    transition: opacity var(--trs-fast);

    &:hover {
      opacity: 0.8;
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
