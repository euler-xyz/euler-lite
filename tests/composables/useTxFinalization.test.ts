import { beforeEach, describe, expect, it, vi } from 'vitest'

const modalMocks = vi.hoisted(() => ({ close: vi.fn() }))
const routerMocks = vi.hoisted(() => ({ replace: vi.fn() }))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => modalMocks,
}))

describe('useTxFinalization', () => {
  let suppress = false

  const setupComposable = async () => {
    const { useTxFinalization } = await import('~/composables/useTxFinalization')
    return useTxFinalization()
  }

  const markSucceeded = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    suppress = false
    modalMocks.close.mockReset()
    routerMocks.replace.mockReset()
    markSucceeded.mockReset()
    vi.stubGlobal('useRouter', () => routerMocks)
    vi.stubGlobal('useSafeExecutionDetachment', () => ({
      markTrackedExecutionSucceeded: markSucceeded,
      shouldSuppressPostTxNavigation: () => suppress,
    }))
  })

  it('closes the modal and redirects for attended executions', async () => {
    const { finalizeTxAndRedirect } = await setupComposable()
    const onAfterClose = vi.fn()

    await finalizeTxAndRedirect({ onAfterClose })
    vi.runAllTimers()

    expect(modalMocks.close).toHaveBeenCalledTimes(1)
    expect(onAfterClose).toHaveBeenCalledTimes(1)
    expect(routerMocks.replace).toHaveBeenCalledWith('/portfolio')
    vi.useRealTimers()
  })

  it('suppresses navigation for detached Safe executions but still runs cleanup', async () => {
    suppress = true
    const { finalizeTxAndRedirect } = await setupComposable()
    const onAfterClose = vi.fn()

    await finalizeTxAndRedirect({ onAfterClose })
    vi.runAllTimers()

    expect(onAfterClose).toHaveBeenCalledTimes(1)
    expect(modalMocks.close).not.toHaveBeenCalled()
    expect(routerMocks.replace).not.toHaveBeenCalled()
    // The finalize point still marks success so the detached toast confirms.
    expect(markSucceeded).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
