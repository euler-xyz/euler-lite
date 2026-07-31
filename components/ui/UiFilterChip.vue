<script setup lang="ts">
defineProps<{
  active?: boolean
}>()
</script>

<template>
  <button
    type="button"
    class="ui-filter-chip"
    :class="{ 'ui-filter-chip--active': active }"
  >
    <slot />
  </button>
</template>

<!-- Unscoped so slotted content (e.g. `.ui-filter-chip__icon`) can be styled
     alongside the pill itself. -->
<style lang="scss">
.ui-filter-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 400;
  background: var(--ui-select-chip-background-color);
  border: 1px solid var(--neutral-300);
  border-radius: 100px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);

  &:hover {
    border-color: var(--neutral-400);
    background: var(--neutral-50);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
  }

  &--active {
    font-weight: 600;
    background: var(--ui-select-chip-active-background-color);
    color: var(--ui-select-chip-active-color);
    border-color: transparent;
    box-shadow: var(--accent-shadow-md);

    &:hover {
      background: var(--accent-600);
      border-color: transparent;
      box-shadow: var(--accent-shadow-lg);
    }
  }

  &__icon {
    width: 16px;
    height: 16px;
  }
}
</style>
