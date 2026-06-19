<script setup lang="ts">
// Error / "would revert" callout used across the batch surfaces (per-operation
// reverts and the top-level batch error in both BatchContents and the review
// modal). Colours are theme-aware on purpose: the shared --error-* tokens are
// identical in light and dark, so a single static red ends up either muddy on
// the dark card or washed-out on white. Here we lean dark-red on the light
// theme and the brighter error-300 on dark — the same bright red the batch
// already uses for negative wallet deltas.
withDefaults(defineProps<{ message: string, compact?: boolean }>(), {
  compact: false,
})
</script>

<template>
  <div
    class="batch-alert"
    :class="{ 'batch-alert--compact': compact }"
    role="alert"
  >
    <SvgIcon
      name="warning-circle"
      class="batch-alert__icon shrink-0"
      :class="compact ? '!w-14 !h-14' : '!w-16 !h-16'"
    />
    <span class="batch-alert__message">{{ message }}</span>
  </div>
</template>

<style scoped lang="scss">
.batch-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-xl);
  font-size: 14px;
  line-height: 20px;
  color: var(--error-500);
  background-color: rgba(var(--error-rgb), 0.07);
  border: 1px solid rgba(var(--error-rgb), 0.18);

  &--compact {
    gap: 7px;
    padding: 8px 10px;
    border-radius: var(--radius-lg);
    font-size: 13px;
    line-height: 18px;
  }
}

.batch-alert__icon {
  margin-top: 1px;
}

.batch-alert__message {
  min-width: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}

[data-theme="dark"] .batch-alert {
  color: var(--error-300);
  background-color: rgba(var(--error-rgb), 0.13);
  border-color: rgba(var(--error-rgb), 0.28);
}
</style>
