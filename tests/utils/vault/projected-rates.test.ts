import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { getProjectedRatesBatch } from '~/utils/vault/apy'

const { batchLensCalls, getEulerSdk } = vi.hoisted(() => ({
  batchLensCalls: vi.fn(),
  getEulerSdk: vi.fn(),
}))

vi.mock('~/utils/multicall', () => ({ batchLensCalls }))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdk }))

const request = (vaultAddress: string) => ({
  vaultAddress,
  currentCash: 100n,
  currentBorrows: 50n,
  cashDelta: 1n,
  borrowsDelta: 0n,
})

describe('getProjectedRatesBatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
      eulerLensAddresses: ref({ vaultLens: '0x0000000000000000000000000000000000000010' }),
      eulerCoreAddresses: ref({ evc: '0x0000000000000000000000000000000000000020' }),
    }))
    getEulerSdk.mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({})) },
    })
    batchLensCalls.mockImplementation(async (_provider, _evc, _lens, _abi, calls: unknown[]) =>
      calls.map((_, index) => ({
        success: true,
        result: {
          queryFailure: false,
          interestRateInfo: [{ supplyAPY: BigInt(index + 1), borrowAPY: BigInt(index + 11) }],
        },
      })),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('coalesces sibling projection requests into one lens batch', async () => {
    const first = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000001')])
    const second = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000002')])

    await vi.runAllTimersAsync()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(batchLensCalls).toHaveBeenCalledTimes(1)
    expect(batchLensCalls.mock.calls[0]?.[4]).toHaveLength(2)
    expect(firstResult[0]).toEqual({ supplyAPY: 1n, borrowAPY: 11n })
    expect(secondResult[0]).toEqual({ supplyAPY: 2n, borrowAPY: 12n })
  })
})
