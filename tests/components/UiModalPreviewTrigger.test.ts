import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { createRenderer, defineComponent, h, KeepAlive, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, ssrContextKey, type App } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UiModalPreviewTrigger from '~/components/ui/UiModalPreviewTrigger.vue'

vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('@floating-ui/vue', async () => {
  const { ref } = await import('vue')
  return {
    arrow: vi.fn(), autoUpdate: vi.fn(), flip: vi.fn(), offset: vi.fn(), shift: vi.fn(), size: vi.fn(),
    useFloating: () => ({ floatingStyles: ref({}), update: vi.fn(), placement: ref('top'), middlewareData: ref({}) }),
  }
})
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return {
    ...vue,
    Transition: vue.defineComponent({ setup: (_, { slots }) => () => slots.default?.() }),
  }
})

// The Node test environment compiles SFCs for SSR; use the actual client template
// to exercise KeepAlive and Teleport with Vue's renderer.
const { descriptor } = parse(readFileSync(new URL('../../components/ui/UiModalPreviewTrigger.vue', import.meta.url), 'utf8'))
const { bindings } = compileScript(descriptor, { id: 'tooltip-test' })
const { code } = compileTemplate({
  source: descriptor.template!.content,
  filename: 'UiModalPreviewTrigger.vue',
  id: 'tooltip-test',
  compilerOptions: { mode: 'function', bindingMetadata: bindings },
})
const Tooltip = { ...UiModalPreviewTrigger, render: new Function('Vue', code)(Vue) }

type TestNode = {
  type: string
  props: Record<string, unknown>
  children: TestNode[]
  parent: TestNode | null
  text: string
  getBoundingClientRect: () => { top: number, bottom: number }
}

const node = (type: string, text = ''): TestNode => ({
  type, text, props: {}, children: [], parent: null,
  getBoundingClientRect: () => ({ top: 100, bottom: 124 }),
})
const descendants = (root: TestNode): TestNode[] => [root, ...root.children.flatMap(descendants)]
const detach = (child: TestNode) => {
  if (!child.parent) return
  child.parent.children.splice(child.parent.children.indexOf(child), 1)
  child.parent = null
}

let app: App | undefined
const keydownListeners = new Set<EventListener>()

const mount = () => {
  const body = node('body')
  const root = node('root')
  const renderer = createRenderer<TestNode, TestNode>({
    createElement: type => node(type),
    createText: text => node('text', text),
    createComment: text => node('comment', text),
    patchProp: (el, key, _previous, value) => { el.props[key] = value },
    insert: (child, parent, anchor) => {
      detach(child)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
      child.parent = parent
    },
    remove: detach,
    setText: (el, text) => { el.text = text },
    setElementText: (el, text) => { el.text = text },
    parentNode: el => el.parent,
    nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
    querySelector: selector => selector === 'body' ? body : null,
  })
  const isLendPage = ref(true)
  let mountCount = 0
  const Details = defineComponent({ render: () => h('div', 'Curator details') })
  const LendPage = defineComponent({
    name: 'LendPage',
    setup() {
      mountCount++
      return () => h(Tooltip, { component: Details, clickable: false })
    },
  })
  app = renderer.createApp({
    render: () => h(KeepAlive, null, {
      default: () => isLendPage.value ? h(LendPage) : h('div', 'Curator profile'),
    }),
  })
  app.provide(ssrContextKey, {})
  app.mount(root)
  const trigger = () => descendants(root).find(el => el.props.class === 'ui-modal-preview-trigger')!
  return {
    isLendPage,
    mountCount: () => mountCount,
    enter: () => (trigger().props.onMouseenter as () => void)(),
    leave: () => (trigger().props.onMouseleave as () => void)(),
    expanded: () => trigger().props['aria-expanded'],
    popovers: () => descendants(body).filter(el => String(el.props.class).split(' ').includes('ui-modal-preview-trigger__popover')),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  keydownListeners.clear()
  vi.stubGlobal('onMounted', onMounted)
  vi.stubGlobal('onDeactivated', onDeactivated)
  vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
  vi.stubGlobal('nextTick', nextTick)
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, innerHeight: 800,
    matchMedia: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  vi.stubGlobal('document', {
    addEventListener: (type: string, handler: EventListener) => {
      if (type === 'keydown') keydownListeners.add(handler)
    },
    removeEventListener: (type: string, handler: EventListener) => {
      if (type === 'keydown') keydownListeners.delete(handler)
    },
  })
})

afterEach(() => {
  app?.unmount()
  app = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('preview tooltips on cached pages', () => {
  it('removes an open teleported popup on navigation and allows hovering after returning', async () => {
    const page = mount()
    page.enter()
    await vi.advanceTimersByTimeAsync(200)
    expect(page.popovers()).toHaveLength(1)
    expect(page.expanded()).toBe(true)
    expect(keydownListeners.size).toBe(1)

    page.isLendPage.value = false
    await nextTick()
    expect(page.popovers()).toHaveLength(0)
    expect(keydownListeners.size).toBe(0)

    page.isLendPage.value = true
    await nextTick()
    expect(page.mountCount()).toBe(1)
    expect(page.popovers()).toHaveLength(0)
    page.enter()
    await vi.advanceTimersByTimeAsync(200)
    expect(page.expanded()).toBe(true)
    page.leave()
    await vi.advanceTimersByTimeAsync(150)
    expect(page.expanded()).toBe(false)
  })

  it('cancels the hover delay when navigating away before the popup opens', async () => {
    const page = mount()
    page.enter()
    page.isLendPage.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    expect(page.popovers()).toHaveLength(0)
    expect(keydownListeners.size).toBe(0)

    page.isLendPage.value = true
    await nextTick()
    expect(page.popovers()).toHaveLength(0)
  })

  it('does not finish opening a popup queued for the next tick after deactivation', async () => {
    const page = mount()
    page.enter()
    vi.advanceTimersByTime(200)
    page.isLendPage.value = false
    await nextTick()
    await nextTick()
    expect(page.popovers()).toHaveLength(0)
    expect(keydownListeners.size).toBe(0)
  })

  it('does not finish opening a popup after its component is unmounted', async () => {
    const page = mount()
    page.enter()
    vi.advanceTimersByTime(200)
    app!.unmount()
    app = undefined
    await nextTick()
    expect(page.popovers()).toHaveLength(0)
    expect(keydownListeners.size).toBe(0)
  })
})
