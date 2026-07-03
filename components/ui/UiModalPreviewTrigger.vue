<script setup lang="ts">
import type { Component } from 'vue'
import { arrow as arrowMiddleware, autoUpdate, flip, offset, shift, size, useFloating, type Placement } from '@floating-ui/vue'
import { type ModalData, useModal } from '~/components/ui/composables/useModal'

defineOptions({
  inheritAttrs: false,
})

const {
  component,
  modalData,
  openDelay = 200,
  closeDelay = 150,
  ariaLabel = 'Show details',
  placement = 'top',
  clickable = true,
  popoverWidth = 'default',
} = defineProps<{
  component: Component
  modalData?: ModalData | (() => ModalData)
  openDelay?: number
  closeDelay?: number
  ariaLabel?: string
  placement?: Placement
  clickable?: boolean
  popoverWidth?: 'default' | 'wide'
}>()

const modal = useModal()
const trigger = ref<HTMLElement>()
const floating = ref<HTMLElement>()
const arrowRef = ref<HTMLElement>()
const canHover = ref(false)
const isVisible = ref(false)
const isRendered = ref(false)
const isPointerInTrigger = ref(false)
const isPointerInPopover = ref(false)
const isKeyboardFocusVisible = ref(false)

let mediaQuery: MediaQueryList | undefined
let openTimer: number | undefined
let closeTimer: number | undefined
let isDocumentKeydownListening = false

const isVerticalPlacement = (value: Placement) =>
  value.startsWith('top') || value.startsWith('bottom')

const withVerticalSide = (value: Placement, side: 'top' | 'bottom'): Placement => {
  const alignment = value.includes('-') ? `-${value.split('-')[1]}` : ''
  return `${side}${alignment}` as Placement
}

const oppositeVerticalPlacement = (value: Placement): Placement => (
  value.startsWith('bottom')
    ? withVerticalSide(value, 'top')
    : withVerticalSide(value, 'bottom')
)

const preferredPlacement = ref<Placement>(placement)

const middleware = computed(() => [
  offset(12),
  flip({
    padding: 8,
    fallbackPlacements: isVerticalPlacement(preferredPlacement.value)
      ? [oppositeVerticalPlacement(preferredPlacement.value)]
      : undefined,
  }),
  shift({ padding: 8 }),
  size({
    padding: 8,
    apply({ availableWidth, availableHeight, elements }) {
      elements.floating.style.maxWidth = `${availableWidth}px`
      elements.floating.style.setProperty('--popover-available-height', `${availableHeight}px`)
    },
  }),
  arrowMiddleware({ element: arrowRef, padding: 12 }),
])

const { floatingStyles, update, placement: resolvedPlacement, middlewareData } = useFloating(trigger, floating, {
  placement: preferredPlacement,
  strategy: 'fixed',
  middleware,
  whileElementsMounted: autoUpdate,
})

const arrowStyles = computed(() => {
  const data = middlewareData.value.arrow
  const side = resolvedPlacement.value.startsWith('bottom') ? 'top' : 'bottom'
  return {
    left: data?.x != null ? `${data.x}px` : '',
    [side]: '-8px',
  }
})

const arrowSide = computed(() =>
  resolvedPlacement.value.startsWith('bottom') ? 'top' : 'bottom',
)

const slideDirection = computed(() =>
  resolvedPlacement.value.startsWith('bottom') ? 'slide-down' : 'slide-up',
)

const popoverWidthClass = computed(() =>
  popoverWidth === 'wide' ? 'ui-modal-preview-trigger__popover--wide' : undefined,
)

const clearOpenTimer = () => {
  if (openTimer !== undefined) {
    window.clearTimeout(openTimer)
    openTimer = undefined
  }
}

const clearCloseTimer = () => {
  if (closeTimer !== undefined) {
    window.clearTimeout(closeTimer)
    closeTimer = undefined
  }
}

const getModalData = (): ModalData => {
  const data = typeof modalData === 'function' ? modalData() : modalData
  return {
    ...(data || {}),
    props: data?.props ? { ...data.props } : undefined,
  }
}

const popoverData = computed(() => {
  const data = getModalData()
  return {
    ...data,
    props: {
      ...(data.props || {}),
      inline: true,
      close: false,
    },
  }
})

const updatePreferredPlacement = () => {
  if (!isVerticalPlacement(placement)) {
    preferredPlacement.value = placement
    return
  }

  const triggerRect = trigger.value?.getBoundingClientRect()
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  const viewportOffsetTop = window.visualViewport?.offsetTop ?? 0
  if (!triggerRect || !viewportHeight) {
    preferredPlacement.value = placement
    return
  }

  const spaceAbove = triggerRect.top - viewportOffsetTop
  const spaceBelow = viewportOffsetTop + viewportHeight - triggerRect.bottom
  preferredPlacement.value = withVerticalSide(
    placement,
    spaceBelow >= spaceAbove ? 'bottom' : 'top',
  )
}

const showPopover = (allowWithoutHover = false) => {
  if (!allowWithoutHover && !canHover.value) return
  clearOpenTimer()
  clearCloseTimer()
  updatePreferredPlacement()
  isRendered.value = true
  nextTick(() => {
    isVisible.value = true
    nextTick(update)
  })
}

const onAfterLeave = () => {
  isRendered.value = false
}

const hidePopover = () => {
  clearOpenTimer()
  clearCloseTimer()
  isVisible.value = false
  isPointerInPopover.value = false
  isKeyboardFocusVisible.value = false
}

const scheduleOpen = () => {
  clearCloseTimer()
  clearOpenTimer()
  openTimer = window.setTimeout(showPopover, openDelay)
}

const scheduleClose = () => {
  clearCloseTimer()
  closeTimer = window.setTimeout(() => {
    if (!isPointerInTrigger.value && !isPointerInPopover.value) {
      hidePopover()
    }
  }, closeDelay)
}

const onMouseEnter = () => {
  isPointerInTrigger.value = true
  if (!canHover.value) return

  scheduleOpen()
}

const onMouseLeave = () => {
  isPointerInTrigger.value = false
  if (!canHover.value) return

  clearOpenTimer()
  scheduleClose()
}

const togglePopover = () => {
  if (isVisible.value) {
    hidePopover()
  }
  else {
    showPopover(true)
  }
}

const onFocus = (event: FocusEvent) => {
  isKeyboardFocusVisible.value = event.target instanceof HTMLElement && event.target.matches(':focus-visible')
  if (!isKeyboardFocusVisible.value) return
  showPopover(true)
}

const onBlur = () => {
  if (!isPointerInPopover.value) {
    hidePopover()
  }
}

const onPopoverMouseEnter = () => {
  isPointerInPopover.value = true
  clearCloseTimer()
}

const onPopoverMouseLeave = () => {
  isPointerInPopover.value = false
  scheduleClose()
}

const stopNavigation = (event: Event) => {
  event.preventDefault()
  event.stopPropagation()
}

const stopPointerPropagation = (event: Event) => {
  event.stopPropagation()
}

const isInteractiveChildEvent = (event: Event) => {
  if (!(event.target instanceof Element) || !trigger.value) return false
  const interactiveChild = event.target.closest([
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))

  return Boolean(
    interactiveChild
    && interactiveChild !== trigger.value
    && trigger.value.contains(interactiveChild),
  )
}

const openModal = () => {
  hidePopover()
  modal.open(component, getModalData())
}

const onClick = (event: Event) => {
  if (!clickable) {
    if (!canHover.value) {
      if (isInteractiveChildEvent(event)) return
      stopNavigation(event)
      togglePopover()
    }
    return
  }
  stopNavigation(event)
  openModal()
}

const onKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
  stopNavigation(event)
  if (!clickable) {
    togglePopover()
    return
  }
  openModal()
}

const onDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    hidePopover()
  }
}

const addDocumentKeydownListener = () => {
  if (isDocumentKeydownListening) return
  document.addEventListener('keydown', onDocumentKeydown)
  isDocumentKeydownListening = true
}

const removeDocumentKeydownListener = () => {
  if (!isDocumentKeydownListening) return
  document.removeEventListener('keydown', onDocumentKeydown)
  isDocumentKeydownListening = false
}

const updateHoverCapability = () => {
  canHover.value = Boolean(mediaQuery?.matches)
  if (!canHover.value) {
    hidePopover()
  }
}

watch(isVisible, (visible) => {
  if (visible) {
    addDocumentKeydownListener()
  }
  else {
    removeDocumentKeydownListener()
  }
})

onMounted(() => {
  mediaQuery = window.matchMedia('(hover: hover)')
  updateHoverCapability()
  mediaQuery.addEventListener('change', updateHoverCapability)
})

onBeforeUnmount(() => {
  mediaQuery?.removeEventListener('change', updateHoverCapability)
  removeDocumentKeydownListener()
  hidePopover()
})
</script>

<template>
  <span
    v-bind="$attrs"
    ref="trigger"
    class="ui-modal-preview-trigger"
    :aria-label="ariaLabel"
    role="button"
    tabindex="0"
    :aria-expanded="isRendered ? isVisible : undefined"
    @pointerdown="stopPointerPropagation"
    @pointerup="stopPointerPropagation"
    @click.capture="onClick"
    @keydown="onKeydown"
    @focus="onFocus"
    @blur="onBlur"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <slot />
  </span>

  <Teleport to="body">
    <div
      v-if="isRendered"
      ref="floating"
      class="ui-modal-preview-trigger__popover"
      :class="[
        { 'ui-modal-preview-trigger__popover--hover-only': !clickable },
        popoverWidthClass,
      ]"
      :style="floatingStyles"
      @click.stop
      @mouseenter="onPopoverMouseEnter"
      @mouseleave="onPopoverMouseLeave"
    >
      <Transition
        :name="slideDirection"
        @after-leave="onAfterLeave"
      >
        <div
          v-if="isVisible"
          class="ui-modal-preview-trigger__popover-inner"
        >
          <div
            ref="arrowRef"
            class="ui-modal-preview-trigger__arrow"
            :class="`ui-modal-preview-trigger__arrow--${arrowSide}`"
            :style="arrowStyles"
          />
          <div class="ui-modal-preview-trigger__popover-content">
            <component
              :is="component"
              v-bind="popoverData.props"
              @close="hidePopover"
            />
          </div>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>

<style lang="scss">
:where(.ui-modal-preview-trigger) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  height: fit-content;
  border-radius: 4px;
  outline: none;
}

.ui-modal-preview-trigger:focus-visible {
  outline: 2px solid var(--accent-600);
  outline-offset: 2px;
}

.ui-modal-preview-trigger__popover {
  z-index: 3100;
  position: relative;
  width: min(480px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  height: fit-content;

  &--hover-only {
    width: min(360px, calc(100vw - 24px));
  }

  &--wide {
    width: min(520px, calc(100vw - 24px));
  }
}

.ui-modal-preview-trigger__popover-inner {
  position: relative;
}

.ui-modal-preview-trigger__popover-content {
  position: relative;
  z-index: 2;
  overflow: hidden;
}

.ui-modal-preview-trigger__arrow {
  position: absolute;
  z-index: 3;
  width: 16px;
  height: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  pointer-events: none;
  transform: rotate(45deg);

  &--bottom {
    border-top: 0;
    border-left: 0;
  }

  &--top {
    border-right: 0;
    border-bottom: 0;
  }
}

.slide-up-enter-active,
.slide-up-leave-active,
.slide-down-enter-active,
.slide-down-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
