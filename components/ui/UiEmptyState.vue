<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  description?: string
  icon?: string
}>(), {
  description: '',
  icon: 'search',
})
</script>

<template>
  <div class="ui-empty-state">
    <div
      class="ui-empty-state__visual"
      aria-hidden="true"
    >
      <slot name="visual">
        <span class="ui-empty-state__halo" />
        <span class="ui-empty-state__curve" />

        <div class="ui-empty-state__card">
          <UiEmptyStateIcon :name="icon" />

          <div class="ui-empty-state__bars">
            <span class="ui-empty-state__bar ui-empty-state__bar--one" />
            <span class="ui-empty-state__bar ui-empty-state__bar--two" />
            <span class="ui-empty-state__bar ui-empty-state__bar--three" />
          </div>
        </div>
      </slot>
    </div>

    <div class="ui-empty-state__content">
      <p class="ui-empty-state__title">
        {{ title }}
      </p>
      <p
        v-if="description"
        class="ui-empty-state__description"
      >
        {{ description }}
      </p>
    </div>

    <div
      v-if="$slots.action"
      class="ui-empty-state__action"
    >
      <slot name="action" />
    </div>
  </div>
</template>

<style lang="scss">
.ui-empty-state {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 260px;
  padding: 32px 16px;
  text-align: center;
  color: var(--text-tertiary);

  &__visual {
    position: relative;
    width: 150px;
    height: 124px;
    margin-bottom: 32px;
  }

  &__halo {
    position: absolute;
    inset: 20px 12px 4px;
    border-radius: var(--radius-full);
    background:
      radial-gradient(circle at 50% 35%, rgba(var(--accent-rgb), 0.14), rgba(var(--accent-rgb), 0) 66%),
      linear-gradient(180deg, rgba(var(--accent-rgb), 0.06), rgba(var(--accent-rgb), 0));
    filter: blur(4px);
    animation: ui-empty-state-halo 7s var(--ease-default) infinite;
  }

  &__curve {
    position: absolute;
    left: 21px;
    top: 32px;
    width: 110px;
    height: 54px;
    border: 1px solid rgba(var(--accent-rgb), 0.2);
    border-right-color: transparent;
    border-bottom-color: transparent;
    border-radius: 999px;
    transform: rotate(-12deg);
    animation: ui-empty-state-curve 8s var(--ease-default) infinite;
  }

  &__card {
    position: absolute;
    left: 50%;
    top: 22px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: 96px;
    padding: 16px 14px 14px;
    border: 1px solid rgba(var(--accent-rgb), 0.16);
    border-radius: 24px;
    background:
      linear-gradient(180deg, rgba(var(--accent-rgb), 0.05), rgba(var(--accent-rgb), 0)),
      var(--bg-card);
    box-shadow: var(--shadow-md), 0 0 0 5px rgba(var(--accent-rgb), 0.025);
    transform: translateX(-50%);
    animation: ui-empty-state-float 6.5s var(--ease-default) infinite;
  }

  &__bars {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    width: 100%;
  }

  &__bar {
    display: block;
    height: 5px;
    border-radius: var(--radius-full);
    background-color: rgba(var(--accent-rgb), 0.16);
    animation: ui-empty-state-bar 6s var(--ease-default) infinite;

    &--one {
      width: 52px;
    }

    &--two {
      width: 38px;
      animation-delay: 0.18s;
    }

    &--three {
      width: 24px;
      animation-delay: 0.36s;
    }
  }

  &__content {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 300px;
    gap: 6px;
  }

  &__title {
    margin: 0;
    color: var(--text-primary);
    font-size: 16px;
    line-height: 20px;
    font-weight: 600;
  }

  &__description {
    margin: 0;
    color: var(--text-tertiary);
    font-size: 14px;
    line-height: 20px;
  }

  &__action {
    display: flex;
    justify-content: center;
    margin-top: 16px;
  }
}

@keyframes ui-empty-state-float {
  0%,
  100% {
    transform: translateX(-50%) translateY(0);
  }

  50% {
    transform: translateX(-50%) translateY(-3px);
  }
}

@keyframes ui-empty-state-halo {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.98);
  }

  50% {
    opacity: 0.82;
    transform: scale(1.02);
  }
}

@keyframes ui-empty-state-curve {
  0%,
  100% {
    opacity: 0.32;
    transform: rotate(-12deg) scale(0.99);
  }

  50% {
    opacity: 0.52;
    transform: rotate(-12deg) scale(1.01);
  }
}

@keyframes ui-empty-state-bar {
  0%,
  100% {
    opacity: 0.52;
    transform: scaleX(0.94);
  }

  50% {
    opacity: 0.78;
    transform: scaleX(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-empty-state {
    &__halo,
    &__card,
    &__bar,
    &__curve {
      animation: none;
    }
  }
}
</style>
