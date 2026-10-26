import { createRenderer, defineComponent, h, nextTick, reactive, ref, shallowRef, ssrContextKey, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BorrowVaultPair } from '~/types/borrow-pair'
import VaultFormInfoButton from '~/components/entities/vault/form/VaultFormInfoButton.vue'

const isMobile = ref(false)
const open = vi.fn()
const modalEntries: { id: number }[] = []
const route = reactive({ hash: '' })
const hash = '#oracle-adapter-0x0000000000000000000000000000000000000001'
const pair = { borrow: {}, collateral: {} } as BorrowVaultPair
const modal = { name: 'VaultOverviewModal' }

vi.mock('@vueuse/core', () => ({ useMediaQuery: () => isMobile }))
vi.mock('#components', () => ({
  get VaultOverviewModal() {
    return modal
  },
}))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open, list: modalEntries }) }))

let app: App
const mount = (initialPair: BorrowVaultPair | null = pair, revealOracleLink = true) => {
  const currentPair = shallowRef<BorrowVaultPair | undefined>(initialPair ?? undefined)
  const renderer = createRenderer({
    patchProp: () => undefined,
    insert: () => undefined,
    remove: () => undefined,
    createElement: (type: string) => ({ type }),
    createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }),
    setText: () => undefined,
    setElementText: () => undefined,
    parentNode: () => null,
    nextSibling: () => null,
  })
  app = renderer.createApp({
    render: () => h(VaultFormInfoButton, { pair: currentPair.value, revealOracleLink }),
  })
  app.component('UiButton', defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }))
  app.provide(ssrContextKey, {})
  app.mount({ type: 'root' })
  return currentPair
}

beforeEach(() => {
  isMobile.value = false
  route.hash = ''
  modalEntries.length = 0
  open.mockReset().mockImplementation(() => {
    const id = modalEntries.length + 1
    modalEntries.push({ id })
    return id
  })
  vi.stubGlobal('useRoute', () => route)
})
afterEach(() => {
  app?.unmount()
  vi.unstubAllGlobals()
})

describe('oracle links in the responsive pair information view', () => {
  it('opens the mobile information view after in-app oracle navigation', async () => {
    isMobile.value = true
    mount()
    expect(open).not.toHaveBeenCalled()
    route.hash = hash
    await nextTick()
    expect(open).toHaveBeenCalledWith(modal, { props: expect.objectContaining({ pair }) })
  })

  it('waits for the pair to load on a direct mobile deep link without reopening on refresh', async () => {
    isMobile.value = true
    route.hash = hash
    const currentPair = mount(null)
    expect(open).not.toHaveBeenCalled()
    currentPair.value = pair
    await nextTick()
    expect(open).toHaveBeenCalledTimes(1)
    currentPair.value = { ...pair }
    await nextTick()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('uses the desktop overview until the viewport switches to mobile', async () => {
    route.hash = hash
    mount()
    expect(open).not.toHaveBeenCalled()
    isMobile.value = true
    await nextTick()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reuses the open information view for another adapter, and can reopen after dismissal', async () => {
    isMobile.value = true
    route.hash = hash
    mount()
    expect(open).toHaveBeenCalledTimes(1)
    route.hash = hash.replace(/1$/, '2')
    await nextTick()
    expect(open).toHaveBeenCalledTimes(1)
    modalEntries.length = 0
    route.hash = hash
    await nextTick()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it.each([
    { target: '#unrelated', reveal: true },
    { target: hash, reveal: false },
  ])('ignores unrelated hashes or buttons: %s', async ({ target, reveal }) => {
    isMobile.value = true
    mount(pair, reveal)
    route.hash = target
    await nextTick()
    expect(open).not.toHaveBeenCalled()
  })
})
