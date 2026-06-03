import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'

const owner = '0x75cFE4ef963232ae8313aC33e21fC39241338618'
const reulAddress = '0x1000000000000000000000000000000000000000'
const eulAddress = '0x2000000000000000000000000000000000000000'

const importUseREULLocks = async () => {
  vi.resetModules()

  const lock = {
    timestamp: 1n,
    amount: 5_920_093_000_000_000_000n,
    unlockableAmount: 5_920_093_000_000_000_000n,
    amountToBeBurned: 0n,
  }
  const fetchLocks = vi.fn(async () => [lock])
  const buildUnlockPlan = vi.fn(async () => ({ kind: 'reul-unlock', steps: [] }))

  vi.doMock('~/composables/useEulerSdk', () => ({
    getEulerSdk: vi.fn(async () => ({
      reulLockService: {
        fetchLocks,
        buildUnlockPlan,
      },
    })),
  }))

  vi.stubGlobal('until', () => ({
    toBeTruthy: vi.fn(async () => true),
  }))
  vi.stubGlobal('onUnmounted', vi.fn())
  vi.stubGlobal('useWagmi', () => ({
    isConnected: ref(false),
    address: ref(undefined),
    chainId: ref(undefined),
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

  const module = await import('~/composables/useREULLocks')
  return {
    ...module,
    fetchLocks,
    lock,
  }
}

describe('useREULLocks', () => {
  let scope: EffectScope | undefined

  afterEach(() => {
    scope?.stop()
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
})
