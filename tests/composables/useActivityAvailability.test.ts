import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'

describe('useActivityAvailability', () => {
  let scope: EffectScope | undefined

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    scope?.stop()
    scope = undefined
  })

  it('does not build the SDK when V3 is disabled for the chain', async () => {
    const getEulerSdkForChain = vi.fn()
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => false }))
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkForChain }))

    const { useActivityAvailability } = await import('~/composables/useActivityAvailability')
    let availability: ReturnType<typeof useActivityAvailability> | undefined
    scope = effectScope()
    scope.run(() => {
      availability = useActivityAvailability({ kind: 'vault', vaultType: 'evk' }, 1)
    })
    await nextTick()

    expect(getEulerSdkForChain).not.toHaveBeenCalled()
    expect(availability?.isSupported.value).toBe(false)
    expect(availability?.reason.value).toBe('v3-disabled')
  })

  it('requires both adapter and scope capability support', async () => {
    const getCapabilities = vi.fn(() => ({
      configured: true,
      adapter: 'v3',
      canQueryAccount: true,
      requestableVaultTypes: ['evk', 'earn', 'securitize'] as const,
    }))
    const getScopeSupport = vi.fn((scope: { kind: string, vaultType?: string }) =>
      scope.vaultType === 'securitize' ? 'unsupported' as const : 'unknown' as const)
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdkForChain: vi.fn(async () => ({ activityService: { getCapabilities, getScopeSupport } })),
    }))

    const { useActivityAvailability } = await import('~/composables/useActivityAvailability')
    const availabilityScope = ref<{
      kind: 'vault'
      vaultType: 'evk' | 'securitize'
    }>({ kind: 'vault', vaultType: 'evk' })
    let availability: ReturnType<typeof useActivityAvailability> | undefined
    scope = effectScope()
    scope.run(() => {
      availability = useActivityAvailability(availabilityScope, 1)
    })

    await vi.waitFor(() => expect(availability?.isSupported.value).toBe(true))
    expect(availability?.scopeSupport.value).toBe('unknown')

    availabilityScope.value = { kind: 'vault', vaultType: 'securitize' }
    await vi.waitFor(() => expect(availability?.reason.value).toBe('unsupported-scope'))
    expect(availability?.isSupported.value).toBe(false)
  })

  it('ignores a capability result from a superseded chain', async () => {
    let resolveFirst: ((sdk: unknown) => void) | undefined
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const getEulerSdkForChain = vi.fn((chainId: number) => chainId === 1
      ? first
      : Promise.resolve({
          activityService: {
            getCapabilities: () => ({
              configured: true,
              adapter: 'v3',
              canQueryAccount: true,
              requestableVaultTypes: ['evk'],
            }),
            getScopeSupport: () => 'unknown',
          },
        }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkForChain }))

    const { useActivityAvailability } = await import('~/composables/useActivityAvailability')
    const chainId = ref(1)
    let availability: ReturnType<typeof useActivityAvailability> | undefined
    scope = effectScope()
    scope.run(() => {
      availability = useActivityAvailability({ kind: 'vault', vaultType: 'evk' }, chainId)
    })

    await vi.waitFor(() => expect(getEulerSdkForChain).toHaveBeenCalledWith(1))
    chainId.value = 8453
    await vi.waitFor(() => expect(availability?.isSupported.value).toBe(true))

    resolveFirst?.({
      activityService: {
        getCapabilities: () => ({
          configured: false,
          adapter: null,
          canQueryAccount: false,
          requestableVaultTypes: [],
          reason: 'source-not-configured',
        }),
        getScopeSupport: () => 'unsupported',
      },
    })
    await nextTick()

    expect(availability?.isSupported.value).toBe(true)
    expect(availability?.reason.value).toBeUndefined()
  })

  it('keeps capability-check failures renderable and retryable', async () => {
    const getEulerSdkForChain = vi.fn()
      .mockRejectedValueOnce(new Error('SDK build failed'))
      .mockResolvedValueOnce({
        activityService: {
          getCapabilities: () => ({
            configured: true,
            adapter: 'v3',
            canQueryAccount: true,
            requestableVaultTypes: ['evk'],
          }),
          getScopeSupport: () => 'unknown',
        },
      })
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkForChain }))

    const { useActivityAvailability } = await import('~/composables/useActivityAvailability')
    let availability: ReturnType<typeof useActivityAvailability> | undefined
    scope = effectScope()
    scope.run(() => {
      availability = useActivityAvailability({ kind: 'vault', vaultType: 'evk' }, 1)
    })

    await vi.waitFor(() => expect(availability?.reason.value).toBe('capability-check-failed'))
    expect(availability?.isSupported.value).toBe(false)
    expect(availability?.shouldRender.value).toBe(true)

    const retry = availability?.refreshAvailability()
    expect(availability?.shouldRender.value).toBe(true)
    expect(availability?.isChecking.value).toBe(true)
    await retry

    expect(availability?.isSupported.value).toBe(true)
    expect(availability?.shouldRender.value).toBe(true)
    expect(availability?.reason.value).toBeUndefined()
  })
})
