<script setup lang="ts">
import { offset, flip, shift, useFloating } from '@floating-ui/vue'

const { exact } = defineProps<{
  exact: string
}>()

const reference = ref(null)
const floating = ref(null)
const isVisible = ref(false)

const { floatingStyles, update } = useFloating(reference, floating, {
  placement: 'top',
  middleware: [
    offset(8),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
  ],
})

const canHover = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

const onMouseEnter = () => {
  if (canHover) {
    isVisible.value = true
    update()
  }
}

const onMouseLeave = () => {
  if (canHover) {
    isVisible.value = false
  }
}
</script>

<template>
  <span
    ref="reference"
    class="ui-exact-amount"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <slot />
    <Transition name="tooltip">
      <div
        v-show="isVisible"
        ref="floating"
        :style="floatingStyles"
        class="ui-exact-amount__floating"
        @click.stop
      >
        {{ exact }}
      </div>
    </Transition>
  </span>
</template>

<style lang="scss">
.ui-exact-amount {
  cursor: default;

  &__floating {
    position: relative;
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
  }
}
</style>
