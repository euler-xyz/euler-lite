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
  const buildUnlockPlan = vi.fn(async (_args: { allowRemainderLoss: boolean }) => unlockPlan)
  const getBlock = vi.fn(async () => ({ number: 500n, timestamp: 1_772_300_000n }))
  const readContract = vi.fn(async ({ functionName }: { functionName: string }): Promise<bigint | bigint[]> =>
    functionName === 'getLockedAmountByLockTimestamp' ? 100n : [30n, 70n])

  const sdk = {
    reulLockService: {
      fetchLocks,
      buildUnlockPlan,
    },
    providerService: {
      getProvider: vi.fn(() => ({ getBlock, readContract })),
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
    getBlock,
    readContract,
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

  const lockDay = 1_772_150_400n
  const dayEnd = lockDay + 86_400n

  const connectedLocks = async () => {
    const module = await importUseREULLocks({ connected: true, address: owner, chainId: 1 })
    let locks: ReturnType<typeof module.useREULLocks> | undefined
    scope = effectScope()
    scope.run(() => {
      locks = module.useREULLocks()
    })
    if (!locks) throw new Error('useREULLocks did not initialize')
    return { ...module, locks }
  }

  it('builds unlock plans through the SDK default EVC path', async () => {
    const { locks, buildUnlockPlan, unlockPlan } = await connectedLocks()

    await expect(locks.buildUnlockREULPlan([lockDay], dayEnd)).resolves.toBe(unlockPlan)
    expect(buildUnlockPlan).toHaveBeenCalledWith({
      chainId: 1,
      account: owner,
      lockTimestamp: lockDay,
      allowRemainderLoss: true,
      rEulAddress: reulAddress,
    })
  })

  it.each([
    ['one second before the lock day ends', dayEnd - 1n, false],
    ['exactly when the lock day ends', dayEnd, true],
    ['after the lock day ends', dayEnd + 1n, true],
    ['without a quote timestamp', undefined, false],
  ])('derives allowRemainderLoss from the quote %s', async (_label, quoteTimestamp, expected) => {
    const { locks, buildUnlockPlan } = await connectedLocks()

    await locks.buildUnlockREULPlan([lockDay], quoteTimestamp)
    expect(buildUnlockPlan).toHaveBeenCalledWith(expect.objectContaining({ allowRemainderLoss: expected }))
  })

  it('ignores the browser clock when deriving allowRemainderLoss', async () => {
    const { locks, buildUnlockPlan } = await connectedLocks()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Number(dayEnd + 30n * 86_400n) * 1000)
    await locks.buildUnlockREULPlan([lockDay], dayEnd - 1n)
    vi.setSystemTime(Number(lockDay - 30n * 86_400n) * 1000)
    await locks.buildUnlockREULPlan([lockDay], dayEnd)

    expect(buildUnlockPlan.mock.calls.map(([args]) => args.allowRemainderLoss))
      .toEqual([false, true])
  })

  it('reads the lock quote and block timestamp from one block', async () => {
    const { locks, getBlock, readContract } = await connectedLocks()

    await expect(locks.readLockSnapshot(lockDay)).resolves.toEqual({
      blockNumber: 500n,
      blockTimestamp: 1_772_300_000n,
      lock: { timestamp: lockDay, amount: 100n, unlockableAmount: 30n, amountToBeBurned: 70n },
    })
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'latest' })
    expect(readContract).toHaveBeenCalledTimes(2)
    for (const [call] of readContract.mock.calls) {
      expect(call).toMatchObject({ address: reulAddress, args: [owner, lockDay], blockNumber: 500n })
    }
  })

  it('fails closed when the lock snapshot cannot be read', async () => {
    const { locks, getBlock } = await connectedLocks()
    getBlock.mockRejectedValueOnce(new Error('rpc down'))

    await expect(locks.readLockSnapshot(lockDay)).resolves.toBeNull()
  })

  it('reports a removed lock as missing in the snapshot', async () => {
    const { locks, readContract } = await connectedLocks()
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'getLockedAmountByLockTimestamp' ? 0n : [0n, 0n])

    await expect(locks.readLockSnapshot(lockDay)).resolves.toMatchObject({ lock: null })
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

  it('clears shared state and invalidates in-flight loads after the final consumer unmounts', async () => {
    const { useREULLocks, fetchLocks, lock, unmountCallbacks } = await importUseREULLocks()

    let locks: ReturnType<typeof useREULLocks> | undefined
    scope = effectScope()
    scope.run(() => {
      locks = useREULLocks()
    })

    if (!locks) throw new Error('useREULLocks did not initialize')
    await vi.waitFor(() => expect(locks?.locks.value).toEqual([lock]))

    const staleLock = {
      ...lock,
      unlockableAmount: lock.unlockableAmount + 1n,
    }
    let resolveRefresh!: (value: typeof lock[]) => void
    const pendingRefresh = new Promise<typeof lock[]>((resolve) => {
      resolveRefresh = resolve
    })
    fetchLocks.mockImplementationOnce(() => pendingRefresh)

    const refreshPromise = locks.refreshLocks()
    await vi.waitFor(() => expect(fetchLocks).toHaveBeenCalledTimes(2))

    scope.stop()
    scope = undefined
    unmountCallbacks[0]?.()
    expect(locks.locks.value).toEqual([])
    expect(locks.isLocksLoading.value).toBe(false)

    resolveRefresh([staleLock])
    await expect(refreshPromise).resolves.toBeNull()
    expect(locks.locks.value).toEqual([])

    scope = effectScope()
    scope.run(() => {
      locks = useREULLocks()
    })
    await vi.waitFor(() => expect(fetchLocks).toHaveBeenCalledTimes(3))
    expect(locks.locks.value).toEqual([lock])
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

    await vi.waitFor(() => expect(fetchLocks).toHaveBeenCalledTimes(1))
    expect(unmountCallbacks).toHaveLength(2)
    unmountCallbacks[0]?.()
    expect(clearIntervalSpy).not.toHaveBeenCalled()
    const callsBeforePoll = fetchLocks.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchLocks).toHaveBeenCalledTimes(callsBeforePoll + 1)

    unmountCallbacks[1]?.()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    const callsAfterUnmount = fetchLocks.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchLocks).toHaveBeenCalledTimes(callsAfterUnmount)
  })
})
