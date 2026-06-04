<script setup lang="ts">
// Themed modal panel for Zip Code flows. Rendered inside UiModal's fixed
// backdrop, so it only provides the centered card + the `.zipcode-theme` scope
// (modals mount outside the layout). Backdrop click closes unless locked.
const props = withDefaults(defineProps<{
  title?: string
  canClose?: boolean
}>(), { canClose: true })

const emit = defineEmits<{ (e: 'close'): void }>()

const onBackdrop = () => {
  if (props.canClose) emit('close')
}
</script>

<template>
  <div
    class="zipcode-theme zip-modal-backdrop"
    @click.self="onBackdrop"
  >
    <div class="zip-modal-panel">
      <div
        v-if="title || canClose"
        class="flex items-center justify-between gap-12 px-24 pt-24"
      >
        <h3 class="zip-display text-[20px]">
          {{ title }}
        </h3>
        <button
          v-if="canClose"
          type="button"
          aria-label="Close"
          class="grid place-items-center w-32 h-32 rounded-full shrink-0"
          style="background: var(--zip-surface-muted); color: var(--zip-text-muted)"
          @click="emit('close')"
        >
          <SvgIcon
            name="close"
            class="w-16 h-16"
          />
        </button>
      </div>
      <div class="px-24 pb-24 pt-16">
        <slot />
      </div>
    </div>
  </div>
</template>
