const isOverflowed = (el: HTMLElement) => {
  return el.scrollWidth - 1 > el.clientWidth
}

const updateSize = (el: HTMLElement) => {
  let currentFontSize = parseInt(el.style.fontSize)
  const maxFontSize = parseInt(el.dataset?.maxFontSize || '100')
  if (isOverflowed(el)) {
    while (isOverflowed(el) && currentFontSize > 1) {
      el.style.fontSize = (currentFontSize - 1) + 'px'
      currentFontSize--
    }
  }
  else {
    currentFontSize = parseInt(el.style.fontSize)
    while (!isOverflowed(el) && currentFontSize < maxFontSize) {
      el.style.fontSize = (currentFontSize + 1) + 'px'
      currentFontSize++
      if (isOverflowed(el)) {
        el.style.fontSize = (currentFontSize - 1) + 'px'
        currentFontSize--
        return
      }
    }
  }
}

const observers: { el: HTMLElement, observer: MutationObserver }[] = []

export default {
  mounted(el: HTMLElement) {
    el.style.fontSize = getComputedStyle(el).fontSize || '32px'
    el.dataset.maxFontSize = el.style.fontSize
    updateSize(el)

    const observer = new MutationObserver((mutationsList) => {
      mutationsList.forEach(() => {
        updateSize(el)
      })
    })
    observers.push({ el, observer })
    nextTick(() => {
      observer.observe(el, { characterData: true, attributes: true, attributeFilter: ['value'] })
    })
  },

  unmounted(el: HTMLElement) {
    const idx = observers.findIndex(observer => observer.el.isSameNode(el))
    if (observers[idx]) {
      observers[idx].observer.disconnect()
      observers.splice(idx, 1)
    }
  },
}
