import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error?: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

const COVERED_VAULT = {
  address: '0x49C5733d71511A78a3E12925ea832f49031c97e9',
  lostAssets: 238869503n,
}

const UNCOVERED_VAULT = {
  address: '0x1111111111111111111111111111111111111111',
  lostAssets: 500n,
}

const loadComposable = async (readContract: ReturnType<typeof vi.fn>) => {
  vi.stubGlobal('useRpcClient', () => ({
    rpcUrl: ref('http://localhost/rpc'),
    client: ref({ readContract }),
  }))

  const { useEarnLossCoverage } = await import('~/composables/useEarnLossCoverage')
  return useEarnLossCoverage
}

describe('useEarnLossCoverage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not read when the vault recorded no shortfall', async () => {
    const readContract = vi.fn()
    const useEarnLossCoverage = await loadComposable(readContract)

    const vault = ref<{ address: string, lostAssets: bigint } | undefined>({
      address: UNCOVERED_VAULT.address,
      lostAssets: 0n,
    })
    const { coverageShares, isCoverageLoading } = useEarnLossCoverage(vault as Ref<never>)
    await nextTick()

    expect(readContract).not.toHaveBeenCalled()
    expect(coverageShares.value).toBeUndefined()
    expect(isCoverageLoading.value).toBe(false)
  })

  it('exposes the coverage shares once the read settles', async () => {
    const readContract = vi.fn().mockResolvedValue(238870000n)
    const useEarnLossCoverage = await loadComposable(readContract)

    const vault = ref<typeof COVERED_VAULT | undefined>(COVERED_VAULT)
    const { coverageShares, isCoverageLoading } = useEarnLossCoverage(vault as Ref<never>)
    await vi.waitFor(() => expect(coverageShares.value).toBe(238870000n))

    expect(isCoverageLoading.value).toBe(false)
    expect(readContract).toHaveBeenCalledTimes(1)
  })

  // Regression: the race guard stops a stale response from landing, but cannot
  // retract a value already committed. Without clearing before the next read,
  // the new vault's shortfall gets netted against the old vault's shares.
  it('drops the previous vault coverage while the next read is pending', async () => {
    const first = deferred<bigint>()
    const second = deferred<bigint>()
    const readContract = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const useEarnLossCoverage = await loadComposable(readContract)

    const vault = ref<typeof COVERED_VAULT | undefined>(COVERED_VAULT)
    const { coverageShares, isCoverageLoading } = useEarnLossCoverage(vault as Ref<never>)

    first.resolve(238870000n)
    await vi.waitFor(() => expect(coverageShares.value).toBe(238870000n))

    vault.value = UNCOVERED_VAULT
    await nextTick()

    expect(isCoverageLoading.value).toBe(true)
    expect(coverageShares.value).toBeUndefined()

    second.resolve(0n)
    await vi.waitFor(() => expect(isCoverageLoading.value).toBe(false))
    expect(coverageShares.value).toBe(0n)
  })

  it('ignores a stale response that resolves after a newer read', async () => {
    const first = deferred<bigint>()
    const second = deferred<bigint>()
    const readContract = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const useEarnLossCoverage = await loadComposable(readContract)

    const vault = ref<typeof COVERED_VAULT | undefined>(COVERED_VAULT)
    const { coverageShares } = useEarnLossCoverage(vault as Ref<never>)
    await nextTick()

    vault.value = UNCOVERED_VAULT
    await nextTick()

    second.resolve(7n)
    await vi.waitFor(() => expect(coverageShares.value).toBe(7n))

    // The first vault's response lands last and must not overwrite the second.
    first.resolve(238870000n)
    await nextTick()
    expect(coverageShares.value).toBe(7n)
  })

  it('treats a failed read as no coverage rather than stale coverage', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('rpc down'))
    const useEarnLossCoverage = await loadComposable(readContract)

    const vault = ref<typeof COVERED_VAULT | undefined>(COVERED_VAULT)
    const { coverageShares, isCoverageLoading } = useEarnLossCoverage(vault as Ref<never>)

    await vi.waitFor(() => expect(isCoverageLoading.value).toBe(false))
    expect(coverageShares.value).toBeUndefined()
  })
})
