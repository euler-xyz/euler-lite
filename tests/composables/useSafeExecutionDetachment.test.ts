import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => toastMocks,
}))

vi.mock('~/utils/tx-errors', () => ({
  getTxErrorMessage: vi.fn(async (err: unknown) => (err as Error).message),
}))

const importComposable = async () => {
  const { useSafeExecutionDetachment } = await import('~/composables/useSafeExecutionDetachment')
  return useSafeExecutionDetachment()
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useSafeExecutionDetachment', () => {
  beforeEach(() => {
    vi.resetModules()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
  })

  it('toasts success and clears the pending state when a detached execution confirms', async () => {
    const detachment = await importComposable()
    let release!: () => void
    const execution = new Promise<void>((resolve) => {
      release = resolve
    })

    detachment.detach(execution)
    expect(detachment.hasDetachedPending.value).toBe(true)
    expect(detachment.shouldSuppressPostTxNavigation()).toBe(true)

    release()
    await flush()
    expect(toastMocks.success).toHaveBeenCalledWith('Safe transaction confirmed')
    expect(detachment.hasDetachedPending.value).toBe(false)
    expect(detachment.shouldSuppressPostTxNavigation()).toBe(false)
  })

  it('toasts the decoded failure when a detached execution rejects', async () => {
    const detachment = await importComposable()
    let reject!: (err: Error) => void
    const execution = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })

    detachment.detach(execution)
    reject(new Error('Safe transaction reverted'))
    await flush()

    expect(toastMocks.error).toHaveBeenCalledWith('Safe transaction reverted')
    expect(detachment.hasDetachedPending.value).toBe(false)
  })

  it('does not suppress navigation while an attached submission is in flight', async () => {
    const detachment = await importComposable()
    detachment.detach(new Promise<void>(() => {}))

    // Another modal is open and submitting — its success must navigate.
    const release = detachment.trackAttached()
    expect(detachment.shouldSuppressPostTxNavigation()).toBe(false)

    release()
    expect(detachment.shouldSuppressPostTxNavigation()).toBe(true)
    // Release is idempotent.
    release()
    expect(detachment.shouldSuppressPostTxNavigation()).toBe(true)
  })
})
