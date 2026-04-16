<script setup lang="ts">
defineProps<{
  exact: string
}>()
</script>

<template>
  <span class="ui-exact-amount">
    <slot />
    <span class="ui-exact-amount__tip">
      {{ exact }}
    </span>
  </span>
</template>

<style lang="scss">
.ui-exact-amount {
  position: relative;

  &__tip {
    display: none;
  }
}

@media (hover: hover) and (pointer: fine) {
  .ui-exact-amount:hover .ui-exact-amount__tip {
    display: block;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    max-width: 500px;
    width: max-content;
    padding: 6px 10px;
    border-radius: 8px;
    background-color: var(--ui-footnote-floating-background-color);
    box-shadow: 0 4px 16px var(--ui-footnote-floating-box-shadow-color);
    z-index: 10;
    font-size: 13px;
    line-height: 18px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
    pointer-events: none;
    word-break: break-all;
    white-space: nowrap;
  }
}
</style>
