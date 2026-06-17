<script lang="ts">
import { LIST_RENDER_BUFFER_PX } from '~/entities/tuning-constants'

// One shared IntersectionObserver serves every instance: observing hundreds
// of rows with a single observer is far cheaper than one observer per row.
const observerCallbacks = new WeakMap<Element, (isIntersecting: boolean) => void>()
let sharedObserver: IntersectionObserver | undefined

const observeElement = (el: Element, callback: (isIntersecting: boolean) => void) => {
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      observerCallbacks.get(entry.target)?.(entry.isIntersecting)
    }
  }, { rootMargin: `${LIST_RENDER_BUFFER_PX}px 0px` })
  observerCallbacks.set(el, callback)
  sharedObserver.observe(el)
}

const unobserveElement = (el: Element | undefined) => {
  if (!el) return
  observerCallbacks.delete(el)
  sharedObserver?.unobserve(el)
}
</script>

<script setup lang="ts">
// Windowed-rendering wrapper for long lists. The slot is mounted only while
// the row is within LIST_RENDER_BUFFER_PX of the viewport; otherwise a
// fixed-height placeholder is rendered so document height (and therefore
// scroll position) stays stable. Offscreen rows are fully unmounted, keeping
// the DOM and JS heap bounded by the viewport instead of the list length.

const props = withDefaults(defineProps<{
  /** Placeholder height used until this row has been measured. */
  estimatedHeight: number
  /** Mount the slot immediately (for rows expected in the first viewport). */
  eager?: boolean
  /** Always render the slot (windowing off, e.g. for parity captures). */
  disabled?: boolean
  placeholderClass?: string
}>(), { eager: false, disabled: false, placeholderClass: '' })

const emit = defineEmits<{ measured: [height: number] }>()

const container = ref<HTMLElement>()
const isNear = ref(props.eager)
const measuredHeight = ref(0)

const shouldRender = computed(() => props.disabled || isNear.value)
const placeholderHeight = computed(() => measuredHeight.value || props.estimatedHeight)

const measure = () => {
  const height = container.value?.offsetHeight ?? 0
  // Zero height means the element is detached from layout (e.g. keep-alive
  // deactivation); keep the previous measurement so the placeholder stays
  // accurate when the page is shown again.
  if (height > 0 && height !== measuredHeight.value) {
    measuredHeight.value = height
    emit('measured', height)
  }
}

const onIntersectionChange = (isIntersecting: boolean) => {
  if (isIntersecting) {
    isNear.value = true
    return
  }
  // The slot is still mounted at this point, so the measurement reflects the
  // real row content rather than the placeholder.
  if (isNear.value) measure()
  isNear.value = false
}

watch(isNear, async (near) => {
  if (!near) return
  await nextTick()
  measure()
})

onMounted(() => {
  if (props.disabled) return
  const el = container.value
  if (!el) return
  observeElement(el, onIntersectionChange)
  if (isNear.value) void nextTick(measure)
})

onBeforeUnmount(() => {
  unobserveElement(container.value)
})
</script>

<template>
  <div ref="container">
    <slot v-if="shouldRender" />
    <div
      v-else
      aria-hidden="true"
      :class="placeholderClass"
      :style="{ height: `${placeholderHeight}px` }"
    />
  </div>
</template>
