import { hasBaseAppInjectedProvider } from '~/utils/base-app-wallet'

const SCROLLABLE_OVERFLOW_RE = /(auto|scroll|overlay)/
const PULL_THRESHOLD_PX = 4

const getScrollableAncestor = (target: EventTarget | null): HTMLElement | null => {
  let node = target instanceof Element ? target : null

  while (node && node !== document.body) {
    const el = node as HTMLElement
    const style = window.getComputedStyle(el)

    if (
      SCROLLABLE_OVERFLOW_RE.test(style.overflowY)
      && el.scrollHeight > el.clientHeight
    ) {
      return el
    }

    node = node.parentElement
  }

  return null
}

export default defineNuxtPlugin(() => {
  if (!hasBaseAppInjectedProvider()) return

  let touchStartY = 0

  const onTouchStart = (event: TouchEvent) => {
    touchStartY = event.touches[0]?.clientY ?? 0
  }

  const onTouchMove = (event: TouchEvent) => {
    const currentY = event.touches[0]?.clientY ?? touchStartY
    const isPullingDown = currentY - touchStartY > PULL_THRESHOLD_PX
    if (!isPullingDown) return

    const scrollable = getScrollableAncestor(event.target)
    const isAtTop = scrollable
      ? scrollable.scrollTop <= 0
      : window.scrollY <= 0

    if (isAtTop) {
      event.preventDefault()
    }
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchmove', onTouchMove, { passive: false })
})
