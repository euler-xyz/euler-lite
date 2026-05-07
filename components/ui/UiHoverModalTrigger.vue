<script setup lang="ts">
import type { Component } from 'vue'
import { type ModalData, useModal } from '~/components/ui/composables/useModal'

const {
  component,
  modalData,
  openDelay = 250,
  closeDelay = 500,
  ariaLabel = 'Show details',
} = defineProps<{
  component: Component
  modalData?: ModalData | (() => ModalData)
  openDelay?: number
  closeDelay?: number
  ariaLabel?: string
}>()

const modal = useModal()
const trigger = ref<HTMLElement>()
const canHover = ref(false)
const isOpen = ref(false)
const openedByHover = ref(false)
const isPointerInModal = ref(false)

let mediaQuery: MediaQueryList | undefined
let modalId: number | undefined
let openTimer: number | undefined
let closeTimer: number | undefined

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

const closeModal = (animate = true) => {
  clearOpenTimer()
  clearCloseTimer()
  removeDocumentListeners()

  if (modalId !== undefined) {
    if (animate && modal.requestClose(modalId)) {
      return
    }

    modal.close(modalId)
  }

  resetOpenState()
}

const resetOpenState = () => {
  modalId = undefined
  isOpen.value = false
  openedByHover.value = false
  isPointerInModal.value = false
}

const removeDocumentListeners = () => {
  document.removeEventListener('mousemove', onDocumentMouseMove)
  document.removeEventListener('click', onDocumentClick, true)
}

const getModalData = (): ModalData => {
  const data = typeof modalData === 'function' ? modalData() : modalData
  return {
    ...(data || {}),
    props: data?.props ? { ...data.props } : undefined,
  }
}

const buildModalData = (source: 'click' | 'hover'): ModalData => {
  const data = getModalData()
  const previousBeforeComponentLeave = data.beforeComponentLeave

  data.beforeComponentLeave = () => {
    previousBeforeComponentLeave?.()
    removeDocumentListeners()
    resetOpenState()
  }

  if (source === 'hover') {
    const previousMouseEnter = data.onMouseEnter
    const previousMouseLeave = data.onMouseLeave

    data.skipHistory ??= true
    data.noLock ??= true
    data.pointerThrough ??= true
    data.onMouseEnter = () => {
      previousMouseEnter?.()
      isPointerInModal.value = true
      clearCloseTimer()
    }
    data.onMouseLeave = () => {
      previousMouseLeave?.()
      isPointerInModal.value = false
      scheduleClose()
    }
  }

  return data
}

const openModal = (source: 'click' | 'hover') => {
  clearOpenTimer()
  clearCloseTimer()

  if (isOpen.value) {
    if (source !== 'click' || !openedByHover.value) {
      openedByHover.value = source === 'hover'
      return
    }

    closeModal(false)
  }

  openedByHover.value = source === 'hover'
  modalId = modal.open(component, buildModalData(source))
  isOpen.value = true

  if (source === 'hover') {
    document.addEventListener('mousemove', onDocumentMouseMove)
    document.addEventListener('click', onDocumentClick, true)
  }
}

const scheduleClose = () => {
  if (!openedByHover.value) return

  clearCloseTimer()
  closeTimer = window.setTimeout(() => {
    closeModal()
  }, closeDelay)
}

const onMouseEnter = () => {
  if (!canHover.value) return

  clearCloseTimer()
  clearOpenTimer()
  openTimer = window.setTimeout(() => {
    openModal('hover')
  }, openDelay)
}

const onMouseLeave = () => {
  if (!canHover.value) return

  clearOpenTimer()
  scheduleClose()
}

const onDocumentMouseMove = (event: MouseEvent) => {
  if (!canHover.value || !openedByHover.value) return

  const target = event.target
  const isPointerInTrigger = isEventInTrigger(target)
  if (isPointerInTrigger || isPointerInModal.value) {
    clearCloseTimer()
    return
  }

  scheduleClose()
}

const isEventInTrigger = (target: EventTarget | null) => {
  return target instanceof Node && Boolean(trigger.value?.contains(target))
}

const onDocumentClick = (event: MouseEvent) => {
  if (!openedByHover.value || isEventInTrigger(event.target) || isPointerInModal.value) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  closeModal()
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
  openModal('click')
}

const updateHoverCapability = () => {
  canHover.value = Boolean(mediaQuery?.matches)
}

onMounted(() => {
  mediaQuery = window.matchMedia('(hover: hover)')
  updateHoverCapability()
  mediaQuery.addEventListener('change', updateHoverCapability)
})

onBeforeUnmount(() => {
  mediaQuery?.removeEventListener('change', updateHoverCapability)
  closeModal(false)
})
</script>

<template>
  <span
    ref="trigger"
    class="ui-hover-modal-trigger"
    role="button"
    tabindex="0"
    :aria-label="ariaLabel"
    @pointerdown="stopPointerPropagation"
    @pointerup="stopPointerPropagation"
    @click.capture="onClick"
    @keydown.enter="onClick"
    @keydown.space="onClick"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <slot />
  </span>
</template>

<style lang="scss">
.ui-hover-modal-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  height: fit-content;
}
</style>
