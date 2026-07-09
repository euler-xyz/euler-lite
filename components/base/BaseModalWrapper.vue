<script setup lang="ts">
const {
  title,
  full = false,
  close = true,
  warning = false,
  inline = false,
  compact = false,
} = defineProps<{
  title?: string
  full?: boolean
  close?: boolean
  warning?: boolean
  inline?: boolean
  compact?: boolean
}>()
const emit = defineEmits(['close'])

const modalEl = ref<HTMLElement>()
const dragY = ref(0)
let startY = 0

// Walk every descendant of the modal to see if anything is scrolled down.
// Covers both BaseModalWrapper's own scroll container AND any nested scroll
// containers inside slot content (e.g. a long list inside a modal).
const isAnyDescendantScrolled = () => {
  if (!modalEl.value) return false
  for (const el of modalEl.value.querySelectorAll('*')) {
    if ((el as HTMLElement).scrollTop > 0) return true
  }
  return false
}

// --- Drag handle zone (pill + header) ---
const onPointerDown = (e: PointerEvent) => {
  if (e.pointerType !== 'touch') return
  if (isAnyDescendantScrolled()) return
  startY = e.clientY
  dragY.value = 0
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
const onPointerMove = (e: PointerEvent) => {
  if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
  dragY.value = Math.max(0, e.clientY - startY)
}
const onPointerUp = (e: PointerEvent) => {
  if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
  if (dragY.value > 80) emit('close')
  dragY.value = 0
}
const onPointerCancel = () => {
  dragY.value = 0
}

// --- Scroll container touch handling ---
// Walk up from the touch target to find if any ancestor within the modal
// is scrolled. This catches nested scroll containers inside slot content.
const isTouchTargetScrolled = (target: EventTarget | null): boolean => {
  let el = target as HTMLElement | null
  while (el && el !== modalEl.value) {
    if (el.scrollTop > 0) return true
    el = el.parentElement
  }
  return false
}

let scrollTouchStartY = 0
let scrollGestureDecided = false
let scrollDragActive = false

const onScrollTouchStart = (e: TouchEvent) => {
  scrollTouchStartY = e.touches[0].clientY
  scrollGestureDecided = false
  scrollDragActive = false
}
const onScrollTouchMove = (e: TouchEvent) => {
  const delta = e.touches[0].clientY - scrollTouchStartY

  if (!scrollGestureDecided) {
    scrollGestureDecided = true
    // Only take over if swiping down AND no ancestor of the touch target is scrolled
    if (delta > 0 && !isTouchTargetScrolled(e.target)) {
      scrollDragActive = true
    }
  }

  if (!scrollDragActive) return
  e.preventDefault()
  dragY.value = Math.max(0, delta)
}
const onScrollTouchEnd = () => {
  scrollGestureDecided = false
  if (!scrollDragActive) return
  scrollDragActive = false
  if (dragY.value > 80) emit('close')
  dragY.value = 0
}
const onScrollTouchCancel = () => {
  scrollGestureDecided = false
  scrollDragActive = false
  dragY.value = 0
}

const dragStyle = computed(() => ({
  transform: dragY.value ? `translateY(${dragY.value}px)` : undefined,
  transition: dragY.value ? 'none' : 'transform 0.3s ease',
}))

const hasHeaderChrome = computed(() => !inline || Boolean(title || close))
const bodyTopPaddingClass = computed(() => {
  if (hasHeaderChrome.value) return ''
  return compact ? '!pt-12' : 'pt-16'
})
</script>

<template>
  <div
    ref="modalEl"
    class="flex flex-col bg-card"
    :class="[
      inline
        ? 'relative w-full max-h-[min(70vh,560px,var(--popover-available-height,100vh))] rounded-8 border border-line-subtle shadow-card'
        : 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 min-w-[min(375px,100vw)] max-w-[600px] max-h-[85dvh] rounded-16 mobile:top-auto mobile:left-0 mobile:bottom-0 mobile:w-full mobile:min-w-full mobile:max-h-[95dvh] mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-t-16 mobile:rounded-b-0',
      full && !inline ? 'min-h-[85dvh] mobile:min-h-[95dvh] min-w-[min(600px,100vw)]' : '',
    ]"
    :style="dragStyle"
  >
    <!-- Drag zone: pill + header, outside the scroll container -->
    <div
      v-if="hasHeaderChrome"
      class="shrink-0 touch-none select-none"
      :class="[
        compact ? 'px-12 pt-14' : 'px-16 pt-12',
        !inline ? 'mobile:pt-0' : '',
      ]"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
    >
      <div
        v-if="!inline"
        class="hidden mobile:flex justify-center py-8"
      >
        <div class="w-36 h-4 rounded-full bg-surface-subtle" />
      </div>

      <div
        v-if="title || close"
        class="flex justify-between items-center"
        :class="compact ? 'mb-8 min-h-24' : 'mb-12 h-36'"
      >
        <div
          v-if="close"
          class="w-36"
        />
        <p
          v-if="title"
          class="flex text-center items-center gap-8"
          :class="compact ? 'text-p2 font-semibold' : 'text-h4'"
        >
          <SvgIcon
            v-if="warning"
            name="warning"
            class="!w-20 !h-20 text-warning-500"
          />
          {{ title }}
        </p>
        <button
          v-if="close"
          type="button"
          class="ui-button ui-button--medium ui-button--primary-stroke is-icon-only"
          name="cross"
          data-modal-close
          aria-label="Close modal"
          @click="emit('close')"
        >
          <div class="ui-button__wrap">
            <div
              class="ui-button__icon"
              aria-hidden="true"
            >
              <SvgIcon
                class="ui-button__icon-svg text-content-secondary"
                name="close"
              />
            </div>
          </div>
        </button>
      </div>
    </div>

    <!-- Scroll container -->
    <div
      class="flex flex-col overflow-x-hidden overscroll-contain px-16 pb-16"
      :class="[
        full ? 'flex-grow min-h-0' : 'overflow-y-auto styled-scrollbar',
        compact ? '!px-12 !pb-12' : '',
        bodyTopPaddingClass,
      ]"
      @touchstart="onScrollTouchStart"
      @touchmove="onScrollTouchMove"
      @touchend="onScrollTouchEnd"
      @touchcancel="onScrollTouchCancel"
    >
      <div
        class="flex flex-col"
        :class="[full ? 'flex-grow min-h-0 overflow-x-hidden overflow-y-auto styled-scrollbar' : '']"
      >
        <slot />
      </div>

      <slot name="bottom" />
    </div>
  </div>
</template>
