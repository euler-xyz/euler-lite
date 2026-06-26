<script setup lang="ts">
withDefaults(defineProps<{
  name?: string
}>(), {
  name: 'search',
})
</script>

<template>
  <span
    class="ui-empty-state-icon"
    aria-hidden="true"
  >
    <span class="ui-empty-state-icon__glow" />
    <span class="ui-empty-state-icon__euler-mark">e</span>
    <UiIcon
      :name="name"
      class="ui-empty-state-icon__icon"
    />
  </span>
</template>

<style lang="scss">
.ui-empty-state-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid rgba(var(--accent-rgb), 0.16);
  border-radius: var(--radius-xl);
  color: var(--accent-500);
  background:
    radial-gradient(circle at 50% 24%, rgba(var(--accent-rgb), 0.12), rgba(var(--accent-rgb), 0) 60%),
    var(--bg-surface-secondary);
  box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.06);
  animation: ui-empty-state-icon-float 6s var(--ease-default) infinite;

  &::after {
    content: '';
    position: absolute;
    inset: -40% -80%;
    background: linear-gradient(90deg, transparent, rgba(var(--accent-rgb), 0.08), transparent);
    transform: translateX(-42%) rotate(18deg);
    animation: ui-empty-state-icon-sheen 8s var(--ease-default) infinite;
  }

  &__glow {
    position: absolute;
    inset: 10px;
    border-radius: var(--radius-full);
    background-color: rgba(var(--accent-rgb), 0.1);
    filter: blur(10px);
    animation: ui-empty-state-icon-glow 7s var(--ease-default) infinite;
  }

  &__euler-mark {
    position: absolute;
    right: 8px;
    bottom: 5px;
    color: currentColor;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    opacity: 0.22;
    transform: rotate(-8deg);
    animation: ui-empty-state-icon-mark 7s var(--ease-default) infinite;
  }

  &__icon {
    position: relative;
    z-index: 1;
    width: 24px;
    height: 24px;
  }
}

@keyframes ui-empty-state-icon-float {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-2px);
  }
}

@keyframes ui-empty-state-icon-sheen {
  0%,
  70% {
    transform: translateX(-42%) rotate(18deg);
    opacity: 0;
  }

  82% {
    opacity: 1;
  }

  100% {
    transform: translateX(42%) rotate(18deg);
    opacity: 0;
  }
}

@keyframes ui-empty-state-icon-glow {
  0%,
  100% {
    opacity: 0.52;
    transform: scale(0.96);
  }

  50% {
    opacity: 0.82;
    transform: scale(1.04);
  }
}

@keyframes ui-empty-state-icon-mark {
  0%,
  100% {
    opacity: 0.18;
    transform: translateY(0) rotate(-8deg);
  }

  50% {
    opacity: 0.3;
    transform: translateY(-1px) rotate(-8deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-empty-state-icon,
  .ui-empty-state-icon::after,
  .ui-empty-state-icon__glow,
  .ui-empty-state-icon__euler-mark {
    animation: none;
  }
}
</style>
