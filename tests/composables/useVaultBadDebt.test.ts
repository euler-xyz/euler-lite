import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef, watchEffect } from 'vue'

describe('useVaultBadDebt', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not request bad debt when v3 is disabled', async () => {
    const chainId = ref(1)
    const fetchMock = vi.fn()

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('shallowRef', shallowRef)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useEnvConfig', () => ({
      enableV3Backend: false,
      v3ApiUrl: '/api/internal/v3',
    }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => false }))
    vi.stubGlobal('fetch', fetchMock)

    const { useVaultBadDebt } = await import('~/composables/useVaultBadDebt')
    const badDebt = useVaultBadDebt()

    await badDebt.loadBadDebtForChain()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(badDebt.isBadDebtEnabled.value).toBe(false)
    expect(badDebt.isBadDebtLoading.value).toBe(false)
    expect(badDebt.isBadDebtLoaded.value).toBe(false)
    expect(badDebt.badDebtError.value).toBeUndefined()
  })

  it('does not request bad debt for a chain pinned to onchain reads', async () => {
    const chainId = ref(1)
    const fetchMock = vi.fn()
    const onchainChainId = 143

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('shallowRef', shallowRef)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useEnvConfig', () => ({
      enableV3Backend: true,
      v3ApiUrl: '/api/internal/v3',
    }))
    vi.stubGlobal('useV3ChainGate', () => ({
      isV3EnabledForChain: (id: number) => id !== onchainChainId,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { useVaultBadDebt } = await import('~/composables/useVaultBadDebt')
    const badDebt = useVaultBadDebt()

    await badDebt.loadBadDebtForChain(onchainChainId)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(badDebt.isBadDebtEnabled.value).toBe(true)
    expect(badDebt.badDebtByChain.value.has(onchainChainId)).toBe(false)
  })
})

describe('useVaultBadDebt after a failed load', () => {
  const setup = async (fetchMock: ReturnType<typeof vi.fn>) => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('shallowRef', shallowRef)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useEnvConfig', () => ({ enableV3Backend: true, v3ApiUrl: '/api/internal/v3' }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
    vi.stubGlobal('fetch', fetchMock)
    const { useVaultBadDebt } = await import('~/composables/useVaultBadDebt')
    return useVaultBadDebt()
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not loop on a persistent error while watchers re-run on its state', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }))
    const badDebt = await setup(fetchMock)
    const stop = watchEffect(() => {
      void badDebt.loadBadDebtForChain()
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(badDebt.isBadDebtLoading.value).toBe(false)
    expect(badDebt.badDebtError.value).toBeInstanceOf(Error)

    await badDebt.loadBadDebtForChain()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await badDebt.loadBadDebtForChain(1, { force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    await badDebt.loadBadDebtForChain()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    stop()
  })

  it('gives up on a response whose body stalls', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    }))
    const badDebt = await setup(fetchMock)
    const pending = badDebt.loadBadDebtForChain()
    await vi.advanceTimersByTimeAsync(15_000)
    await pending
    expect(badDebt.isBadDebtLoading.value).toBe(false)
    expect(badDebt.badDebtError.value).toBeInstanceOf(Error)
  })

  it('gives up on a request that does not answer and stops reporting loading', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const badDebt = await setup(fetchMock)
    const pending = badDebt.loadBadDebtForChain()
    expect(badDebt.isBadDebtLoading.value).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    await pending
    expect(badDebt.isBadDebtLoading.value).toBe(false)
    expect(badDebt.badDebtError.value).toBeInstanceOf(Error)
  })
})
