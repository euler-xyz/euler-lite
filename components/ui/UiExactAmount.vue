<script setup lang="ts">
const props = defineProps<{
  exact: string
  placement?: 'top' | 'bottom'
}>()

const copied = ref(false)
let timer: ReturnType<typeof setTimeout>

function onCopy() {
  const numericPart = props.exact.replace(/\s+\S+$/, '').replaceAll(',', '')
  navigator.clipboard.writeText(numericPart)
  copied.value = true
  clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), 2000)
}
</script>

<template>
  <span
    class="ui-exact-amount"
    :class="{ 'ui-exact-amount--bottom': props.placement === 'bottom' }"
  >
    <slot />
    <span
      class="ui-exact-amount__tip"
      @click.stop.prevent
      @mousedown.stop.prevent
      @pointerdown.stop.prevent
    >
      {{ exact }}
      <button
        class="ui-exact-amount__copy"
        @click="onCopy"
      >
        <SvgIcon
          :name="copied ? 'check' : 'copy'"
          class="!w-14 !h-14"
        />
      </button>
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
    display: flex;
    align-items: center;
    gap: 6px;
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
    z-index: 4000;
    font-size: 13px;
    line-height: 18px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
    word-break: break-all;
    white-space: nowrap;
    user-select: all;
    cursor: text;

    // invisible bridge to cover the gap between trigger and tooltip
    &::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 0;
      width: 100%;
      height: 6px;
    }
  }

  .ui-exact-amount--bottom:hover .ui-exact-amount__tip {
    top: calc(100% + 6px);
    bottom: auto;

    &::after {
      top: auto;
      bottom: 100%;
    }
  }

  .ui-exact-amount__copy {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
    transition: color 0.15s;

    &:hover {
      color: var(--text-primary);
    }
  }
}
</style>
