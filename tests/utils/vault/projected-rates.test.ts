import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { areProjectedRatesComplete, getProjectedRatesBatch } from '~/utils/vault/apy'

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
  const chainId = ref(1)
  const eulerLensAddresses = ref({ vaultLens: '0x0000000000000000000000000000000000000010' })
  const eulerCoreAddresses = ref({ evc: '0x0000000000000000000000000000000000000020' })
  const getProvider = vi.fn((id: number) => ({ chainId: id }))

  beforeEach(() => {
    vi.useFakeTimers()
    getProvider.mockImplementation((id: number) => ({ chainId: id }))
    chainId.value = 1
    eulerLensAddresses.value = { vaultLens: '0x0000000000000000000000000000000000000010' }
    eulerCoreAddresses.value = { evc: '0x0000000000000000000000000000000000000020' }
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId,
      eulerLensAddresses,
      eulerCoreAddresses,
    }))
    getEulerSdk.mockResolvedValue({
      providerService: { getProvider },
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

  it('merges same-vault deltas into one atomic projected state', async () => {
    const projection = getProjectedRatesBatch([
      {
        vaultAddress: '0x0000000000000000000000000000000000000001',
        currentCash: 100n,
        currentBorrows: 50n,
        cashDelta: 20n,
        borrowsDelta: 0n,
      },
      {
        vaultAddress: '0x0000000000000000000000000000000000000001',
        currentCash: 100n,
        currentBorrows: 50n,
        cashDelta: -10n,
        borrowsDelta: 10n,
      },
    ])

    await vi.runAllTimersAsync()
    const result = await projection

    const calls = batchLensCalls.mock.calls[0]?.[4]
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([
      '0x0000000000000000000000000000000000000001',
      [110n],
      [60n],
    ])
    expect(result).toEqual([
      { supplyAPY: 1n, borrowAPY: 11n },
      { supplyAPY: 1n, borrowAPY: 11n },
    ])
  })

  it('fails closed when same-vault requests disagree on their base state', async () => {
    const result = await getProjectedRatesBatch([
      request('0x0000000000000000000000000000000000000001'),
      {
        ...request('0x0000000000000000000000000000000000000001'),
        currentCash: 99n,
      },
    ])

    expect(result).toEqual([null, null])
    expect(batchLensCalls).not.toHaveBeenCalled()
  })

  it('normalizes reverted and transport-failed EVC batch items to null', async () => {
    batchLensCalls.mockResolvedValue([
      { success: false, result: null },
      { success: false, result: null, transportError: true },
      { success: true, result: { queryFailure: true, interestRateInfo: [] } },
    ])

    const projection = getProjectedRatesBatch([
      request('0x0000000000000000000000000000000000000001'),
      request('0x0000000000000000000000000000000000000002'),
      request('0x0000000000000000000000000000000000000003'),
    ])

    await vi.runAllTimersAsync()

    expect(await projection).toEqual([null, null, null])
  })

  it('keeps a failed fallback read scoped to its own request', async () => {
    eulerCoreAddresses.value = {} as { evc: string }
    const readContract = vi.fn()
      .mockRejectedValueOnce(new Error('rpc failed'))
      .mockResolvedValueOnce({
        queryFailure: false,
        interestRateInfo: [{ supplyAPY: 7n, borrowAPY: 17n }],
      })
    getProvider.mockReturnValue({ readContract } as never)

    const first = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000001')])
    const second = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000002')])

    await vi.runAllTimersAsync()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(batchLensCalls).not.toHaveBeenCalled()
    expect(readContract).toHaveBeenCalledTimes(2)
    expect(firstResult).toEqual([null])
    expect(secondResult).toEqual([{ supplyAPY: 7n, borrowAPY: 17n }])
  })

  it('rejects every caller in a deployment group when the provider cannot be resolved', async () => {
    getProvider.mockImplementation(() => {
      throw new Error('unsupported chain')
    })

    const first = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000001')])
    const second = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000002')])
    const settled = Promise.allSettled([first, second])

    await vi.runAllTimersAsync()

    expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
  })

  it('keeps queued projections scoped to their enqueue-time chain deployment', async () => {
    const first = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000001')])

    chainId.value = 2
    eulerLensAddresses.value = { vaultLens: '0x0000000000000000000000000000000000000030' }
    eulerCoreAddresses.value = { evc: '0x0000000000000000000000000000000000000040' }
    const second = getProjectedRatesBatch([request('0x0000000000000000000000000000000000000002')])

    await vi.runAllTimersAsync()
    await Promise.all([first, second])

    expect(getProvider.mock.calls.map(([id]) => id)).toEqual([1, 2])
    expect(batchLensCalls).toHaveBeenCalledTimes(2)
    expect(batchLensCalls.mock.calls[0]?.slice(1, 3)).toEqual([
      '0x0000000000000000000000000000000000000020',
      '0x0000000000000000000000000000000000000010',
    ])
    expect(batchLensCalls.mock.calls[1]?.slice(1, 3)).toEqual([
      '0x0000000000000000000000000000000000000040',
      '0x0000000000000000000000000000000000000030',
    ])
  })
})

describe('areProjectedRatesComplete', () => {
  const projected = { supplyAPY: 1n, borrowAPY: 2n }

  it('accepts a complete projected-rate batch', () => {
    expect(areProjectedRatesComplete([projected, projected], 2)).toBe(true)
  })

  it('rejects an explicit null result', () => {
    expect(areProjectedRatesComplete([projected, null], 2)).toBe(false)
  })

  it('rejects a short result array', () => {
    expect(areProjectedRatesComplete([projected], 2)).toBe(false)
  })
})
