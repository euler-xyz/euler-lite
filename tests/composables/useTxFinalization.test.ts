import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackedExecutionScope } from '~/composables/useSafeExecutionDetachment'

const modalMocks = vi.hoisted(() => ({ close: vi.fn() }))
const routerMocks = vi.hoisted(() => ({ replace: vi.fn() }))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => modalMocks,
}))

describe('useTxFinalization', () => {
  let suppress = false
  const markSucceeded = vi.fn()
  const scope: TrackedExecutionScope = {
    markSucceeded,
    suppressPostTxUi: () => suppress,
  }

  const setupComposable = async () => {
    const { useTxFinalization } = await import('~/composables/useTxFinalization')
    return useTxFinalization()
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    suppress = false
    modalMocks.close.mockReset()
    routerMocks.replace.mockReset()
    markSucceeded.mockReset()
    vi.stubGlobal('useRouter', () => routerMocks)
  })

  it('closes the modal and redirects for attended executions', async () => {
    const { finalizeTxAndRedirect } = await setupComposable()
    const onAfterClose = vi.fn()

    await finalizeTxAndRedirect({ onAfterClose, scope })
    vi.runAllTimers()

    expect(markSucceeded).toHaveBeenCalledTimes(1)
    expect(modalMocks.close).toHaveBeenCalledTimes(1)
    expect(onAfterClose).toHaveBeenCalledTimes(1)
    expect(routerMocks.replace).toHaveBeenCalledWith('/portfolio')
    vi.useRealTimers()
  })

  it('suppresses navigation for detached executions but still runs cleanup', async () => {
    suppress = true
    const { finalizeTxAndRedirect } = await setupComposable()
    const onAfterClose = vi.fn()

    await finalizeTxAndRedirect({ onAfterClose, scope })
    vi.runAllTimers()

    // The finalize point still marks success on THIS execution's scope so
    // the detached toast confirms.
    expect(markSucceeded).toHaveBeenCalledTimes(1)
    expect(onAfterClose).toHaveBeenCalledTimes(1)
    expect(modalMocks.close).not.toHaveBeenCalled()
    expect(routerMocks.replace).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('behaves plainly for untracked flows (no scope)', async () => {
    const { finalizeTxAndRedirect } = await setupComposable()

    await finalizeTxAndRedirect()
    vi.runAllTimers()

    expect(modalMocks.close).toHaveBeenCalledTimes(1)
    expect(routerMocks.replace).toHaveBeenCalledWith('/portfolio')
    vi.useRealTimers()
  })
})
