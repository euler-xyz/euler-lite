<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { NuxtLink } from '#components'

const emits = defineEmits<{
  (e: 'click', event: Event): void
}>()
const props = withDefaults(defineProps<{
  size?: 'small' | 'medium' | 'large' | 'xlarge'
  variant?: 'primary' | 'primary-stroke' | 'secondary' | 'secondary-ghost' | 'red' | 'red-destructive'
  type?: HTMLButtonElement['type']
  icon?: string
  to?: RouteLocationRaw
  href?: string
  target?: string
  disabled?: boolean
  loading?: boolean
  iconRight?: boolean
  iconOnly?: boolean
  rounded?: boolean
}>(), {
  size: 'medium',
  variant: 'primary',
  type: 'button',
})

const bindedAttrs = computed(() => {
  if (props.href) {
    return {
      href: props.href,
    }
  }

  if (props.to) {
    return {
      to: props.to,
    }
  }

  return {}
})
const tag = computed(() => {
  return props.href ? 'a' : props.to ? NuxtLink : 'button'
})
const classes = computed(() => {
  return {
    [`ui-button--${props.size}`]: props.size,
    [`ui-button--${props.variant}`]: props.variant,
    'is-disabled': props.disabled,
    'is-loading': props.loading,
    'is-icon-only': props.iconOnly,
    'is-rounded': props.rounded,
  }
})

const onClick = (e: Event) => {
  if (props.loading || props.disabled) {
    return
  }

  emits('click', e)
}
</script>

<template>
  <component
    :is="tag"
    :disabled="disabled"
    :class="classes"
    class="ui-button"
    :target="target"
    :type="type"
    v-bind="bindedAttrs"
    @click="onClick"
  >
    <div
      v-show="!loading"
      class="ui-button__wrap"
    >
      <div
        v-if="((icon && !iconRight) || $slots.icon)"
        class="ui-button__icon"
        aria-hidden="true"
      >
        <slot name="icon">
          <SvgIcon
            class="ui-button__icon-svg"
            :name="icon!"
          />
        </slot>
      </div>

      <div
        v-if="!iconOnly && $slots.default"
        class="ui-button__text"
      >
        <slot />
      </div>

      <div
        v-if="((icon && iconRight) || $slots.iconRight)"
        class="ui-button__icon"
        aria-hidden="true"
      >
        <slot name="iconRight">
          <SvgIcon
            class="ui-button__icon-svg"
            :name="icon!"
          />
        </slot>
      </div>
    </div>

    <div
      v-if="loading"
      class="ui-button__wrap"
    >
      <div class="ui-button__loading">
        <SvgIcon
          class="ui-button__icon-svg"
          name="loading"
        />
      </div>
    </div>
  </component>
</template>

<style lang="scss">
.ui-button {
  $block: &;

  position: relative;
  display: inline-flex;
  overflow: hidden;
  padding: 10px 16px;
  font-weight: 500;
  text-align: center;
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
  border: none;
  text-decoration: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);

  &.is-loading {
    pointer-events: none;
    opacity: 0.6;
  }

  &.is-disabled {
    pointer-events: none;
  }

  &.is-rounded {
    width: 100%;
  }

  &__wrap {
    display: flex;
    flex-grow: 1;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    gap: 8px;
  }

  &__text {
    position: relative;
    z-index: 1;
    pointer-events: none;
  }

  &__icon {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
  }

  &__icon-svg {
    width: 20px;
    height: 20px;
  }

  &__loading {
    width: 20px;
    height: 20px;
    animation: rotate 0.6s infinite linear;
  }

  &--small {
    font-size: 12px;
    line-height: 16px;
    min-width: 32px;
    min-height: 32px;
    padding: 8px 12px;
    border-radius: 8px;

    &.is-icon-only {
      padding: 8px;
    }
  }

  &--medium {
    font-size: 14px;
    line-height: 20px;
    min-width: 36px;
    min-height: 36px;
    padding: 8px 16px;
    border-radius: 10px;

    &.is-icon-only {
      padding: 10px;
    }
  }

  &--large {
    font-size: 15px;
    line-height: 20px;
    min-width: 44px;
    min-height: 44px;
    padding: 12px 24px;
    border-radius: 12px;

    #{$block}__icon {
      width: 20px;
      height: 20px;
    }

    &.is-icon-only {
      padding: 16px;
    }
  }

  &--xlarge {
    font-size: 16px;
    line-height: 20px;
    min-width: 52px;
    min-height: 52px;
    padding: 16px 28px;
    border-radius: 14px;

    #{$block}__icon {
      width: 24px;
      height: 24px;
    }

    &.is-icon-only {
      padding: 20px;
    }
  }

  &--primary {
    background-color: var(--ui-button-primary-background-color);
    color: var(--ui-button-primary-color);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06);

    &:hover {
      background-color: var(--ui-button-primary-active-background-color);
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      transform: translateY(-1px);
    }

    &:active {
      background-color: var(--ui-button-primary-focus-active-background-color);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
      transform: translateY(0);
    }

    &:focus-visible {
      background-color: var(--ui-button-primary-focus-background-color);
      outline: 2px solid var(--ui-button-primary-focus-outline-color);
      outline-offset: 2px;
    }

    &.is-disabled {
      background-color: var(--ui-button-primary-disabled-background-color);
      color: var(--ui-button-primary-disabled-color);
      box-shadow: none;
      transform: none;
    }
  }

  &--primary-stroke {
    background-color: var(--ui-button-primary-stroke-background-color);
    color: var(--ui-button-primary-stroke-color);
    box-shadow: inset 0 0 0 1px var(--ui-button-primary-stroke-border-color), 0 1px 2px rgba(0, 0, 0, 0.04);

    &:hover {
      background-color: var(--ui-button-primary-stroke-hover-background-color);
      box-shadow: inset 0 0 0 1px var(--ui-button-primary-stroke-border-color), 0 2px 4px rgba(0, 0, 0, 0.06);
    }

    &:active {
      background-color: var(--ui-button-primary-stroke-active-background-color);
      box-shadow: inset 0 0 0 1px var(--ui-button-primary-stroke-border-color);
    }

    &:focus-visible {
      outline: 2px solid var(--ui-button-primary-stroke-focus-outline-color);
      outline-offset: 2px;
    }

    &.is-disabled {
      box-shadow: inset 0 0 0 1px var(--ui-button-primary-stroke-disabled-border-color);
      color: var(--ui-button-primary-stroke-disabled-color);
      background-color: var(--ui-button-primary-stroke-disabled-background-color);
    }
  }

  &--secondary {
    background-color: var(--ui-button-secondary-background-color);
    color: var(--ui-button-secondary-color);
    box-shadow: inset 0 0 0 1px var(--ui-button-secondary-border-color), 0 1px 2px rgba(0, 0, 0, 0.04);

    &:hover {
      background-color: var(--ui-button-secondary-hover-background-color);
      box-shadow: inset 0 0 0 1px var(--ui-button-secondary-hover-border-color), 0 2px 4px rgba(0, 0, 0, 0.06);
    }

    &:active {
      background-color: var(--ui-button-secondary-active-background-color);
      box-shadow: inset 0 0 0 1px var(--ui-button-secondary-hover-border-color);
    }

    &:focus-visible {
      outline: 2px solid var(--ui-button-secondary-focus-outline-color);
      outline-offset: 2px;
    }

    &.is-disabled {
      background-color: var(--ui-button-secondary-disabled-background-color);
      color: var(--ui-button-secondary-disabled-color);
      box-shadow: none;
    }
  }

  &--secondary-ghost {
    background-color: transparent;
    color: var(--ui-button-secondary-ghost-color);
    box-shadow: none;

    &:hover {
      background-color: var(--ui-button-secondary-ghost-hover-background-color);
    }

    &:active {
      background-color: var(--ui-button-secondary-ghost-active-background-color);
    }

    &:focus-visible {
      outline: 2px solid var(--ui-button-secondary-ghost-focus-outline-color);
      outline-offset: 2px;
    }

    &.is-disabled {
      color: var(--ui-button-secondary-ghost-disabled-color);
    }
  }

  &--red {
    background-color: var(--ui-button-red-background-color);
    color: var(--ui-button-red-color);
    box-shadow: inset 0 0 0 1px var(--ui-button-red-border-color), 0 1px 2px rgba(0, 0, 0, 0.04);

    &:hover {
      background-color: var(--ui-button-red-hover-background-color);
      box-shadow: inset 0 0 0 1px var(--ui-button-red-border-color), 0 2px 4px rgba(0, 0, 0, 0.06);
    }

    &:active {
      box-shadow: inset 0 0 0 1px var(--ui-button-red-border-color);
    }

    &:focus-visible {
      background-color: var(--ui-button-red-hover-background-color);
      outline: 2px solid var(--ui-button-red-focus-outline-color);
      outline-offset: 2px;
    }

    &.is-disabled {
      box-shadow: none;
      background-color: var(--ui-button-red-disabled-background-color);
      color: var(--ui-button-red-disabled-color);
    }
  }

  &--red-destructive {
    background-color: transparent;
    color: var(--ui-button-red-destructive-color);
    box-shadow: none;

    &:hover {
      box-shadow: inset 0 0 0 1px var(--ui-button-red-destructive-hover-border-color);
      background-color: var(--ui-button-red-destructive-hover-background-color);
    }

    &:active {
      box-shadow: inset 0 0 0 1px var(--ui-button-red-destructive-hover-border-color);
      background-color: var(--ui-button-red-destructive-active-background-color);
    }

    &:focus-visible {
      outline: 2px solid var(--ui-button-red-destructive-focus-outline-color);
      outline-offset: 2px;
    }

    &.is-disabled {
      color: var(--ui-button-red-destructive-disabled-color);
    }
  }

  @keyframes rotate {
    0% {
      transform: rotate(0);
    }

    100% {
      transform: rotate(360deg);
    }
  }
}
</style>
