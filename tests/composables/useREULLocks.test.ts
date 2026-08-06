import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'

const owner = '0x75cFE4ef963232ae8313aC33e21fC39241338618'
const reulAddress = '0x1000000000000000000000000000000000000000'
const eulAddress = '0x2000000000000000000000000000000000000000'

const importUseREULLocks = async (wallet: {
  connected?: boolean
  address?: string
  chainId?: number
} = {}) => {
  vi.resetModules()

  const unmountCallbacks: Array<() => void> = []

  const lock = {
    timestamp: 1n,
    amount: 5_920_093_000_000_000_000n,
    unlockableAmount: 5_920_093_000_000_000_000n,
    amountToBeBurned: 0n,
  }
  const fetchLocks = vi.fn(async () => [lock])
  const unlockPlan = { kind: 'reul-unlock', steps: [] }
  const buildUnlockPlan = vi.fn(async () => unlockPlan)

  const sdk = {
    reulLockService: {
      fetchLocks,
      buildUnlockPlan,
    },
  }
  vi.doMock('~/composables/useEulerSdk', () => ({
    getEulerSdk: vi.fn(async () => sdk),
    getEulerSdkForChain: vi.fn(async () => sdk),
  }))

  vi.stubGlobal('until', () => ({
    toBeTruthy: vi.fn(async () => true),
  }))
  vi.stubGlobal('onUnmounted', (callback: () => void) => {
    unmountCallbacks.push(callback)
  })
  vi.stubGlobal('useWagmi', () => ({
    isConnected: ref(wallet.connected ?? false),
    address: ref(wallet.address),
    chainId: ref(wallet.chainId),
  }))
  vi.stubGlobal('useEulerAddresses', () => ({
    chainId: ref(1),
    eulerTokenAddresses: ref({
      EUL: eulAddress,
      rEUL: reulAddress,
      eUSD: undefined,
      seUSD: undefined,
    }),
  }))
  vi.stubGlobal('useSpyMode', () => ({
    spyAddress: ref(owner),
  }))
  // Mirrors the real helper: verified spy address wins, the connected wallet
  // is only used outside spy mode.
  vi.stubGlobal('useEffectiveAddress', () => ({
    effectiveAddress: ref(owner || wallet.address),
  }))

  const module = await import('~/composables/useREULLocks')
  return {
    ...module,
    fetchLocks,
    buildUnlockPlan,
    unlockPlan,
    lock,
    unmountCallbacks,
  }
}

describe('useREULLocks', () => {
  let scope: EffectScope | undefined

  afterEach(() => {
    scope?.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('loads spy-mode locks from the selected app chain when no wallet chain is connected', async () => {
    const { useREULLocks, fetchLocks, lock } = await importUseREULLocks()

    let locks: ReturnType<typeof useREULLocks> | undefined
    scope = effectScope()
    scope.run(() => {
      locks = useREULLocks()
    })

    await vi.waitFor(() => expect(fetchLocks).toHaveBeenCalledTimes(1))

    expect(fetchLocks).toHaveBeenCalledWith({
      chainId: 1,
      account: owner,
      rEulAddress: reulAddress,
    })
    expect(locks?.locks.value).toEqual([lock])
    expect(locks?.isLocksLoading.value).toBe(false)
  })

  it('builds unlock plans through the SDK default EVC path', async () => {
    const { useREULLocks, buildUnlockPlan, unlockPlan } = await importUseREULLocks({
      connected: true,
      address: owner,
      chainId: 1,
    })

    let locks: ReturnType<typeof useREULLocks> | undefined
    scope = effectScope()
    scope.run(() => {
      locks = useREULLocks()
    })

    if (!locks) throw new Error('useREULLocks did not initialize')
    await expect(locks.buildUnlockREULPlan([123n])).resolves.toBe(unlockPlan)
    expect(buildUnlockPlan).toHaveBeenCalledWith({
      chainId: 1,
      account: owner,
      lockTimestamp: 123n,
      allowRemainderLoss: true,
      rEulAddress: reulAddress,
    })
  })

  it('removes stale rows while a required post-transaction refresh is pending', async () => {
    const { useREULLocks, fetchLocks, lock } = await importUseREULLocks()

    let locks: ReturnType<typeof useREULLocks> | undefined
    scope = effectScope()
    scope.run(() => {
      locks = useREULLocks()
    })

    if (!locks) throw new Error('useREULLocks did not initialize')
    await vi.waitFor(() => expect(locks?.locks.value).toEqual([lock]))

    const refreshedLock = {
      ...lock,
      unlockableAmount: lock.unlockableAmount + 1n,
      amountToBeBurned: 1n,
    }
    let resolveRefresh!: (value: typeof lock[]) => void
    const pendingRefresh = new Promise<typeof lock[]>((resolve) => {
      resolveRefresh = resolve
    })
    fetchLocks.mockImplementationOnce(() => pendingRefresh)

    const refreshPromise = locks.refreshLocks(true)

    expect(locks.isLocksLoading.value).toBe(true)
    expect(locks.locks.value).toEqual([])

    resolveRefresh([refreshedLock])
    await expect(refreshPromise).resolves.toEqual([refreshedLock])
    expect(locks.isLocksLoading.value).toBe(false)
    expect(locks.locks.value).toEqual([refreshedLock])
  })

  it('keeps the shared poller alive until the last sibling consumer unmounts', async () => {
    vi.useFakeTimers()
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const { useREULLocks, fetchLocks, unmountCallbacks } = await importUseREULLocks()

    scope = effectScope()
    scope.run(() => {
      useREULLocks()
      useREULLocks()
    })

    expect(unmountCallbacks).toHaveLength(2)
    unmountCallbacks[0]?.()
    expect(clearIntervalSpy).not.toHaveBeenCalled()
    const callsBeforePoll = fetchLocks.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchLocks.mock.calls.length).toBeGreaterThan(callsBeforePoll)

    unmountCallbacks[1]?.()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    const callsAfterUnmount = fetchLocks.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchLocks).toHaveBeenCalledTimes(callsAfterUnmount)
  })
})
