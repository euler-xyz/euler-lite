import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => toastMocks,
}))

vi.mock('~/utils/tx-errors', () => ({
  getTxErrorMessage: vi.fn(async (err: unknown) => (err as Error).message),
}))

const wagmiMocks = vi.hoisted(() => ({
  config: {},
  account: { address: '0x1000000000000000000000000000000000000000', connector: { id: 'safe' } },
  onChange: undefined as undefined | ((account: { address?: string, connector?: { id?: string } }) => void),
}))

vi.mock('@wagmi/vue', () => ({
  useConfig: () => wagmiMocks.config,
}))

vi.mock('@wagmi/vue/actions', () => ({
  getAccount: () => wagmiMocks.account,
  watchAccount: (_config: unknown, { onChange }: { onChange: (a: never) => void }) => {
    wagmiMocks.onChange = onChange
  },
}))

const importComposable = async () => {
  const mod = await import('~/composables/useSafeExecutionDetachment')
  return { detachment: mod.useSafeExecutionDetachment(), mod }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useSafeExecutionDetachment', () => {
  beforeEach(() => {
    vi.resetModules()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    toastMocks.warning.mockReset()
  })

  it('latches the wallet classification at submission time', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: true })!

    expect(handle.safeAtSubmit).toBe(true)
    handle.release()
  })

  it('toasts success only when the flow reached its finalize point', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    let release!: () => void
    const execution = new Promise<void>((resolve) => {
      release = resolve
    })

    handle.detach(execution)
    expect(detachment.hasPendingDetachedExecution.value).toBe(true)
    expect(handle.scope.suppressPostTxUi()).toBe(true)

    // The flow's success tail runs finalize before the promise resolves.
    handle.scope.markSucceeded()
    release()
    await flush()

    expect(toastMocks.success).toHaveBeenCalledWith('Safe transaction confirmed')
    expect(toastMocks.warning).not.toHaveBeenCalled()
    expect(detachment.hasPendingDetachedExecution.value).toBe(false)
  })

  it('warns instead of confirming when the execution resolves without finalize', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    let release!: () => void
    const execution = new Promise<void>((resolve) => {
      release = resolve
    })

    // Flow swallowed its error and resolved — never report as confirmed.
    handle.detach(execution)
    release()
    await flush()

    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.warning).toHaveBeenCalledWith('Safe transaction did not complete — check your Safe for details')
  })

  it('toasts the decoded failure when a detached execution rejects', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    let reject!: (err: Error) => void
    const execution = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })

    handle.detach(execution)
    reject(new Error('Safe transaction reverted'))
    await flush()

    expect(toastMocks.error).toHaveBeenCalledWith('Safe transaction reverted')
    expect(detachment.hasPendingDetachedExecution.value).toBe(false)
  })

  it('gates new submissions while a detached execution is pending', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    handle.detach(new Promise<void>(() => {}))

    // Single-slot: a second confirm cannot begin.
    expect(detachment.beginTrackedExecution({ safeAtSubmit: false })).toBeNull()
    expect(detachment.hasPendingDetachedExecution.value).toBe(true)
  })

  it('refuses to overwrite a live attended execution', async () => {
    const { detachment } = await importComposable()
    const first = detachment.beginTrackedExecution({ safeAtSubmit: true })!

    // A second attended submission must not steal the slot: the first
    // handle would be orphaned (its detach would no-op) and finalize-point
    // success marks would land on the wrong execution.
    expect(detachment.beginTrackedExecution({ safeAtSubmit: false })).toBeNull()

    // The first execution retains full control of its slot.
    let release!: () => void
    first.detach(new Promise<void>((resolve) => {
      release = resolve
    }))
    expect(detachment.hasPendingDetachedExecution.value).toBe(true)
    first.scope.markSucceeded()
    release()
    await flush()
    expect(toastMocks.success).toHaveBeenCalledTimes(1)
  })

  it('frees the slot when an attended execution settles without detaching', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: false })!

    handle.release()
    expect(handle.scope.suppressPostTxUi()).toBe(false)
    // The next submission can begin immediately.
    expect(detachment.beginTrackedExecution({ safeAtSubmit: true })).not.toBeNull()
  })

  it('abandons the tracked execution on account or connector switch', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    let release!: () => void
    handle.detach(new Promise<void>((resolve) => {
      release = resolve
    }))
    expect(detachment.hasPendingDetachedExecution.value).toBe(true)

    // Disconnect the Safe, connect an EOA: the gate must not follow the
    // user to the new wallet.
    wagmiMocks.onChange?.({ address: '0x2000000000000000000000000000000000000000', connector: { id: 'io.metamask' } })
    expect(detachment.hasPendingDetachedExecution.value).toBe(false)
    // A new submission can begin immediately.
    const next = detachment.beginTrackedExecution({ safeAtSubmit: false })
    expect(next).not.toBeNull()
    next!.release()

    // The abandoned execution's continuation stays silent — no toast for a
    // wallet that is no longer connected — and its own scope still
    // suppresses its late tail's navigation/teardown.
    expect(handle.scope.suppressPostTxUi()).toBe(true)
    release()
    await flush()
    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.warning).not.toHaveBeenCalled()
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('does not abandon on a same-wallet change event', async () => {
    const { detachment } = await importComposable()
    const handle = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    handle.detach(new Promise<void>(() => {}))

    wagmiMocks.onChange?.({ address: '0x1000000000000000000000000000000000000000', connector: { id: 'safe' } })
    expect(detachment.hasPendingDetachedExecution.value).toBe(true)
  })

  it('scopes success marking to the owning execution across abandonment overlap', async () => {
    const { detachment } = await importComposable()
    const first = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    let releaseFirst!: () => void
    first.detach(new Promise<void>((resolve) => {
      releaseFirst = resolve
    }))

    // Wallet switch abandons A and frees the slot for B.
    wagmiMocks.onChange?.({ address: '0x2000000000000000000000000000000000000000', connector: { id: 'io.metamask' } })
    const second = detachment.beginTrackedExecution({ safeAtSubmit: true })!
    let releaseSecond!: () => void
    second.detach(new Promise<void>((resolve) => {
      releaseSecond = resolve
    }))

    // A's late tail marks A's OWN record — never B's. A is abandoned, so no
    // toast; B resolving unmarked must warn, not falsely confirm.
    first.scope.markSucceeded()
    expect(first.scope.suppressPostTxUi()).toBe(true)
    releaseFirst()
    releaseSecond()
    await flush()
    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.warning).toHaveBeenCalledTimes(1)
  })
})
