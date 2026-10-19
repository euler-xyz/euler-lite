import { createRenderer, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVaultOpeningNotice } from '~/composables/useVaultOpeningNotice'

const modal = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => modal }))
vi.mock('#components', () => ({ VaultOpeningNoticeModal: { name: 'VaultOpeningNoticeModal' } }))

const FLAGGED = '0x00000000000000000000000000000000000000a1'
const PENDING = '0x00000000000000000000000000000000000000a2'
const LISTED = '0x00000000000000000000000000000000000000a3'
const UNLABELLED = '0x00000000000000000000000000000000000000a4'

const isReady = ref(true)
const source = ref('v3')
const visibility = ref<Record<string, { status: string, decidedBy?: string, reason?: string | null }>>({})
const verified = ref(new Set<string>([LISTED]))
const registryVersion = ref(0)
const router = { replace: vi.fn(), back: vi.fn(), options: { history: { state: { back: null as string | null } } } }

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
  insertStaticContent: () => undefined as never,
})

const mountNotice = (addresses: () => string[]) => {
  const app = renderer.createApp({
    setup() {
      useVaultOpeningNotice(addresses)
      return () => h('span')
    },
  })
  app.mount({ type: 'root' })
  return app
}

const openedProps = () => modal.open.mock.calls[0]?.[1]?.props as { flaggedText?: string, cancelAction: () => void, acceptAction?: () => void }

describe('vault opening pop-up', () => {
  beforeEach(() => {
    modal.open.mockReset().mockReturnValue(7)
    modal.close.mockReset()
    router.replace.mockReset()
    router.back.mockReset()
    router.options.history.state.back = null
    isReady.value = true
    source.value = 'v3'
    verified.value = new Set([LISTED])
    visibility.value = {
      [FLAGGED]: { status: 'hidden', decidedBy: 'config-failed', reason: 'A required check failed' },
      [PENDING]: { status: 'pending_review', decidedBy: 'awaiting-verification' },
      [LISTED]: { status: 'visible', decidedBy: 'verified' },
    }
    vi.stubGlobal('useEulerLabels', () => ({ isReady, source, visibility }))
    vi.stubGlobal('useVaultRegistry', () => ({
      isVerifiedVault: (address: string) => verified.value.has(address.toLowerCase()),
      registryVersion,
    }))
    vi.stubGlobal('useRouter', () => router)
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['no verdict', UNLABELLED],
    ['a pending-review verdict', PENDING],
  ])('asks the strict question for a vault with %s and sends Cancel home', (_case, address) => {
    const app = mountNotice(() => [address])
    expect(modal.open).toHaveBeenCalledTimes(1)
    expect(modal.open.mock.calls[0]?.[0]).toEqual({ name: 'VaultOpeningNoticeModal' })
    expect(modal.open.mock.calls[0]?.[1]).toMatchObject({ isNotClosable: true })
    expect(openedProps().flaggedText).toBeUndefined()
    openedProps().cancelAction()
    expect(router.replace).toHaveBeenCalledWith('/')
    app.unmount()
  })

  it('shows the flagged notice for a hidden vault and Go back returns to the previous page', () => {
    router.options.history.state.back = '/lend'
    const app = mountNotice(() => [FLAGGED])
    expect(modal.open).toHaveBeenCalledTimes(1)
    expect(modal.open.mock.calls[0]?.[1]).toMatchObject({ isNotClosable: true })
    expect(openedProps().flaggedText).toBe('Euler\'s checks flagged this vault: A required check failed. Continue only if you understand the risk.')
    openedProps().cancelAction()
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.replace).not.toHaveBeenCalled()
    app.unmount()
  })

  it('sends Go back home when there is no previous page', () => {
    const app = mountNotice(() => [FLAGGED])
    openedProps().cancelAction()
    expect(router.back).not.toHaveBeenCalled()
    expect(router.replace).toHaveBeenCalledWith('/')
    app.unmount()
  })

  it('keeps the strict question for a pair with one unknown and one flagged side', () => {
    const app = mountNotice(() => [FLAGGED, PENDING])
    expect(openedProps().flaggedText).toBeUndefined()
    app.unmount()
  })

  it('asks the strict question when labels do not come from V3, even with a hidden verdict', () => {
    source.value = 'static'
    const app = mountNotice(() => [FLAGGED])
    expect(modal.open).toHaveBeenCalledTimes(1)
    expect(openedProps().flaggedText).toBeUndefined()
    app.unmount()
  })

  it('leaves the route alone when the user goes on', () => {
    const app = mountNotice(() => [FLAGGED])
    expect(openedProps().acceptAction).toBeUndefined()
    expect(router.replace).not.toHaveBeenCalled()
    expect(router.back).not.toHaveBeenCalled()
    app.unmount()
  })

  it('opens nothing for a listed vault, or a listed pair', () => {
    const app = mountNotice(() => [LISTED, LISTED])
    expect(modal.open).not.toHaveBeenCalled()
    app.unmount()
  })

  it('waits for the vault and the labels, then decides once per page', async () => {
    isReady.value = false
    const loaded = ref(false)
    const app = mountNotice(() => loaded.value ? [LISTED] : [])
    loaded.value = true
    await nextTick()
    expect(modal.open).not.toHaveBeenCalled()

    isReady.value = true
    await nextTick()
    expect(modal.open).not.toHaveBeenCalled()

    verified.value = new Set()
    visibility.value = { [LISTED]: { status: 'hidden', decidedBy: 'config-failed', reason: 'Later' } }
    await nextTick()
    expect(modal.open).not.toHaveBeenCalled()
    app.unmount()
  })

  it('opens the pop-up once even when the verdict changes or labels refresh', async () => {
    const app = mountNotice(() => [UNLABELLED])
    expect(modal.open).toHaveBeenCalledTimes(1)
    isReady.value = false
    await nextTick()
    isReady.value = true
    visibility.value = { [UNLABELLED]: { status: 'hidden', decidedBy: 'config-failed', reason: 'Later' } }
    await nextTick()
    expect(modal.open).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('closes an open pop-up when the page unmounts', () => {
    const app = mountNotice(() => [UNLABELLED])
    app.unmount()
    expect(modal.close).toHaveBeenCalledWith(7)
  })

  it('leaves a pop-up the user already answered alone on unmount', () => {
    const app = mountNotice(() => [UNLABELLED])
    modal.open.mock.calls[0]?.[1]?.onClose?.()
    app.unmount()
    expect(modal.close).not.toHaveBeenCalled()
  })
})
