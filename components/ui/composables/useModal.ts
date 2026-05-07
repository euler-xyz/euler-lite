import { useEventBus } from '@vueuse/core'
import type { Raw } from 'vue'

export interface ModalData {
  transition?: string
  dropdown?: boolean
  noLock?: boolean
  absolute?: boolean
  pointerThrough?: boolean
  skipHistory?: boolean
  isNotClosable?: boolean
  custom?: boolean
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  props?: Record<string, any> // eslint-disable-line
  [key: string]: any // eslint-disable-line
}

let scrollLocked = false

function lockScroll() {
  if (scrollLocked) return
  scrollLocked = true
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
  document.body.style.overflow = 'hidden'
  if (scrollbarWidth > 0) {
    document.body.style.paddingRight = `${scrollbarWidth}px`
  }
}

function unlockScroll() {
  scrollLocked = false
  document.body.style.overflow = ''
  document.body.style.paddingRight = ''
}

let popstateHandler: EventListener | undefined
const list: { id: number, component: Raw<Component>, data: ModalData }[] = reactive([])
const hasModal = computed(() => list.length > 0)
const bus = useEventBus<string>('modal')
const requestCloseHandlers = new Map<number, () => void>()

export const useModal = () => {
  const onClickBack = (id?: number | undefined) => {
    close(id, true)
  }

  const open = (component: Component, data: ModalData = {}) => {
    if (popstateHandler) {
      // sometimes pushState can trigger unwanted closings of modals
      window.removeEventListener('popstate', popstateHandler)
    }
    const id = Math.random()
    list.push({
      id,
      component: markRaw(component),
      data,
    })

    // Skip history management for non-closable modals — they can't be
    // dismissed via the back button and pushing state would cause
    // history.back() in close() to undo any navigation the modal triggers.
    if (!data.isNotClosable && !data.skipHistory) {
      popstateHandler = () => onClickBack(id)
      window.history.pushState({ ...window.history.state, modalId: id }, component.name || 'Modal window')
      window.addEventListener('popstate', popstateHandler)
    }

    if (!data.noLock) {
      lockScroll()
    }

    if (data.absolute) {
      bus.emit('open')
    }

    return id
  }

  const registerRequestClose = (id: number, handler: () => void) => {
    requestCloseHandlers.set(id, handler)

    return () => {
      if (requestCloseHandlers.get(id) === handler) {
        requestCloseHandlers.delete(id)
      }
    }
  }

  const requestClose = (id: number) => {
    const handler = requestCloseHandlers.get(id)
    handler?.()
    return Boolean(handler)
  }

  const close = (id?: number | undefined, isBack = false) => {
    if (popstateHandler) {
      window.removeEventListener('popstate', popstateHandler)
      popstateHandler = undefined
    }

    if (id === undefined) {
      list.pop()
    }
    else {
      const index = list.findIndex(item => item.id === id)
      if (index !== -1) {
        list.splice(index, 1)
      }
    }

    if (id !== undefined) {
      requestCloseHandlers.delete(id)
    }

    if (!isBack && window.history.state?.modalId === id) {
      window.history.back()
    }

    if (!list.some(item => !item.data.noLock)) {
      unlockScroll()
    }

    bus.emit('close')
  }

  return {
    list,
    open,
    close,
    registerRequestClose,
    requestClose,
    hasModal,
  }
}
