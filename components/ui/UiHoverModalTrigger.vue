<script setup lang="ts">
import type { Component } from 'vue'
import { arrow as arrowMiddleware, autoPlacement, autoUpdate, offset, shift, size, useFloating, type Placement } from '@floating-ui/vue'
import { type ModalData, useModal } from '~/components/ui/composables/useModal'

const {
  component,
  modalData,
  openDelay = 200,
  closeDelay = 150,
  ariaLabel = 'Show details',
  placement = 'top',
} = defineProps<{
  component: Component
  modalData?: ModalData | (() => ModalData)
  openDelay?: number
  closeDelay?: number
  ariaLabel?: string
  placement?: Placement
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

let mediaQuery: MediaQueryList | undefined
let openTimer: number | undefined
let closeTimer: number | undefined
let isDocumentKeydownListening = false

const { floatingStyles, update, placement: resolvedPlacement, middlewareData } = useFloating(trigger, floating, {
  placement,
  strategy: 'fixed',
  middleware: [
    offset(12),
    autoPlacement({ allowedPlacements: ['top', 'bottom'], padding: 8 }),
    shift({ padding: 8 }),
    size({
      padding: 8,
      apply({ availableWidth, availableHeight, elements }) {
        elements.floating.style.maxWidth = `${availableWidth}px`
        elements.floating.style.setProperty('--popover-available-height', `${availableHeight}px`)
      },
    }),
    arrowMiddleware({ element: arrowRef, padding: 12 }),
  ],
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

const showPopover = () => {
  if (!canHover.value) return
  clearOpenTimer()
  clearCloseTimer()
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

const onClick = (event: Event) => {
  stopNavigation(event)
  hidePopover()
  modal.open(component, getModalData())
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
    ref="trigger"
    class="ui-hover-modal-trigger"
    :aria-label="ariaLabel"
    @pointerdown="stopPointerPropagation"
    @pointerup="stopPointerPropagation"
    @click.capture="onClick"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <slot />
  </span>

  <Teleport to="body">
    <div
      v-if="isRendered"
      ref="floating"
      class="ui-hover-modal-trigger__popover"
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
          class="ui-hover-modal-trigger__popover-inner"
        >
          <div
            ref="arrowRef"
            class="ui-hover-modal-trigger__arrow"
            :class="`ui-hover-modal-trigger__arrow--${arrowSide}`"
            :style="arrowStyles"
          />
          <div class="ui-hover-modal-trigger__popover-content">
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
.ui-hover-modal-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  height: fit-content;

  &__popover {
    z-index: 3100;
    position: relative;
    width: min(480px, calc(100vw - 24px));
    max-width: calc(100vw - 24px);
    height: fit-content;
  }

  &__popover-inner {
    position: relative;
  }

  &__popover-content {
    position: relative;
    z-index: 2;
    overflow: hidden;
  }

  &__arrow {
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
