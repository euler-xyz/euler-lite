<script setup lang="ts">
import type { Component } from 'vue'
import { autoUpdate, flip, offset, shift, useFloating, type Placement } from '@floating-ui/vue'
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
const canHover = ref(false)
const isVisible = ref(false)
const isPointerInTrigger = ref(false)
const isPointerInPopover = ref(false)

let mediaQuery: MediaQueryList | undefined
let openTimer: number | undefined
let closeTimer: number | undefined
let isDocumentKeydownListening = false

const { floatingStyles, update } = useFloating(trigger, floating, {
  placement,
  strategy: 'fixed',
  middleware: [
    offset(8),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
  ],
  whileElementsMounted: autoUpdate,
})

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
  isVisible.value = true
  nextTick(update)
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
    :title="ariaLabel"
    @pointerdown="stopPointerPropagation"
    @pointerup="stopPointerPropagation"
    @click.capture="onClick"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <slot />
  </span>

  <Teleport to="body">
    <Transition
      name="tooltip"
      @enter="update"
      @after-enter="update"
    >
      <div
        v-if="isVisible"
        ref="floating"
        class="ui-hover-modal-trigger__popover"
        :style="floatingStyles"
        @click.stop
        @mouseenter="onPopoverMouseEnter"
        @mouseleave="onPopoverMouseLeave"
      >
        <component
          :is="component"
          v-bind="popoverData.props"
          @close="hidePopover"
        />
      </div>
    </Transition>
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
    width: min(420px, calc(100vw - 24px));
    max-width: calc(100vw - 24px);
  }
}
</style>
