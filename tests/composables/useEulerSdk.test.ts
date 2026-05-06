import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'

type MockSdk = { id: string }

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const importUseEulerSdk = async (
  chainIds: Ref<number[]>,
  buildEulerSDK: ReturnType<typeof vi.fn>,
) => {
  vi.resetModules()
  vi.doMock('@eulerxyz/euler-v2-sdk', () => ({
    buildEulerSDK,
    createPythPlugin: vi.fn(() => ({ name: 'pyth' })),
  }))
  vi.stubGlobal('useEulerAddresses', () => ({ allowedChainIds: chainIds }))

  return await import('~/composables/useEulerSdk')
}

describe('useEulerSdk', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not let an older build overwrite the SDK for the current config', async () => {
    const chainIds = ref([1])
    const sdkA: MockSdk = { id: 'a' }
    const sdkB: MockSdk = { id: 'b' }
    const builds: Array<Deferred<MockSdk>> = []
    const buildEulerSDK = vi.fn((_options: { rpcUrls: Record<number, string> }) => {
      const deferred = createDeferred<MockSdk>()
      builds.push(deferred)
      return deferred.promise
    })
    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)

    const firstBuild = getEulerSdk()
    expect(buildEulerSDK).toHaveBeenCalledTimes(1)

    chainIds.value = [2]
    const secondBuild = getEulerSdk()
    expect(buildEulerSDK).toHaveBeenCalledTimes(2)

    builds[1].resolve(sdkB)
    await expect(secondBuild).resolves.toBe(sdkB)

    builds[0].resolve(sdkA)
    await expect(firstBuild).resolves.toBe(sdkA)

    await expect(getEulerSdk()).resolves.toBe(sdkB)
    expect(buildEulerSDK).toHaveBeenCalledTimes(2)
  })

  it('clears a rejected build so the same config can retry', async () => {
    const chainIds = ref([1])
    const sdk: MockSdk = { id: 'retry' }
    const buildEulerSDK = vi.fn()
      .mockRejectedValueOnce(new Error('build failed'))
      .mockResolvedValueOnce(sdk)
    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)

    await expect(getEulerSdk()).rejects.toThrow('build failed')
    await expect(getEulerSdk()).resolves.toBe(sdk)
    await expect(getEulerSdk()).resolves.toBe(sdk)
    expect(buildEulerSDK).toHaveBeenCalledTimes(2)
  })
})
