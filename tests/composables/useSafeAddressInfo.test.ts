import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SAFE_ADDRESS = '0x00000000000000000000000000000000000000aa'
const OTHER_ADDRESS = '0x00000000000000000000000000000000000000bb'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const SAFE_141_SINGLETON = '0x41675C099F32341bf84BFc5382aF534df5C7461a'
const UNKNOWN_SINGLETON = '0x1111111111111111111111111111111111111111'

const OWNERS = [
  '0x00000000000000000000000000000000000000a1',
  '0x00000000000000000000000000000000000000a2',
  '0x00000000000000000000000000000000000000a3',
  '0x00000000000000000000000000000000000000a4',
  '0x00000000000000000000000000000000000000a5',
  '0x00000000000000000000000000000000000000a6',
  '0x00000000000000000000000000000000000000a7',
]

type ReadContractArgs = { address: string, functionName: string }

const safeClient = (singleton: string = SAFE_141_SINGLETON) => {
  const calls: ReadContractArgs[] = []
  return {
    calls,
    readContract: vi.fn(async ({ address, functionName }: ReadContractArgs) => {
      calls.push({ address, functionName })
      if (functionName === 'masterCopy') return singleton
      if (functionName === 'getThreshold') return 3n
      if (functionName === 'getOwners') return OWNERS
      throw new Error(`unexpected function ${functionName}`)
    }),
  }
}

const eoaClient = () => ({
  readContract: vi.fn(async () => {
    throw new Error('returned no data ("0x")')
  }),
})

const stubEnvironment = (client: unknown) => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useRpcClient', () => ({ client: ref(client) }))
}

const importComposable = async () => {
  const { useSafeAddressInfo } = await import('~/composables/useSafeAddressInfo')
  return useSafeAddressInfo
}

describe('useSafeAddressInfo', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('detects a Safe and exposes threshold and owners', async () => {
    const client = safeClient()
    stubEnvironment(client)
    const useSafeAddressInfo = await importComposable()

    const { safeInfo } = useSafeAddressInfo(() => SAFE_ADDRESS)
    expect(safeInfo.value).toBeNull()

    await vi.waitFor(() => expect(safeInfo.value).not.toBeNull())
    expect(safeInfo.value).toEqual({
      version: '1.4.1',
      threshold: 3,
      owners: OWNERS,
    })
    expect(client.calls.map(call => call.functionName).sort()).toEqual(
      ['getOwners', 'getThreshold', 'masterCopy'],
    )
  })

  it('reports null for a proxy pointing at an unknown singleton', async () => {
    const client = safeClient(UNKNOWN_SINGLETON)
    stubEnvironment(client)
    const useSafeAddressInfo = await importComposable()

    const { safeInfo } = useSafeAddressInfo(() => SAFE_ADDRESS)
    await vi.waitFor(() => expect(client.readContract).toHaveBeenCalled())
    await Promise.resolve()
    expect(safeInfo.value).toBeNull()
  })

  it('reports null for EOAs and non-Safe contracts', async () => {
    const client = eoaClient()
    stubEnvironment(client)
    const useSafeAddressInfo = await importComposable()

    const { safeInfo } = useSafeAddressInfo(() => SAFE_ADDRESS)
    await vi.waitFor(() => expect(client.readContract).toHaveBeenCalledTimes(3))
    await Promise.resolve()
    expect(safeInfo.value).toBeNull()
  })

  it('never probes sentinel or invalid addresses', async () => {
    const client = safeClient()
    stubEnvironment(client)
    const useSafeAddressInfo = await importComposable()

    useSafeAddressInfo(() => ZERO_ADDRESS)
    useSafeAddressInfo(() => 'not-an-address')
    useSafeAddressInfo(() => null)

    await Promise.resolve()
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it('shares the cache between composable instances', async () => {
    const client = safeClient()
    stubEnvironment(client)
    const useSafeAddressInfo = await importComposable()

    const first = useSafeAddressInfo(() => SAFE_ADDRESS)
    await vi.waitFor(() => expect(first.safeInfo.value).not.toBeNull())

    const second = useSafeAddressInfo(() => SAFE_ADDRESS)
    await vi.waitFor(() => expect(second.safeInfo.value).not.toBeNull())
    // 3 reads for the first instance, none for the second.
    expect(client.readContract).toHaveBeenCalledTimes(3)
  })

  it('does not cache transport failures as negatives', async () => {
    const readContract = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP request failed'))
      .mockRejectedValueOnce(new Error('HTTP request failed'))
      .mockRejectedValueOnce(new Error('HTTP request failed'))
      .mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'masterCopy') return SAFE_141_SINGLETON
        if (functionName === 'getThreshold') return 3n
        return OWNERS
      })
    stubEnvironment({ readContract })
    const useSafeAddressInfo = await importComposable()

    const first = useSafeAddressInfo(() => SAFE_ADDRESS)
    await vi.waitFor(() => expect(readContract).toHaveBeenCalledTimes(3))
    // Macrotask flush so the failed probe fully settles and releases its
    // in-flight slot before the retry instance is created.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(first.safeInfo.value).toBeNull()

    // A fresh instance retries because the transport failure was not cached.
    const second = useSafeAddressInfo(() => SAFE_ADDRESS)
    await vi.waitFor(() => expect(second.safeInfo.value).not.toBeNull())
  })

  it('probes distinct addresses independently', async () => {
    const client = safeClient()
    stubEnvironment(client)
    const useSafeAddressInfo = await importComposable()

    const first = useSafeAddressInfo(() => SAFE_ADDRESS)
    const second = useSafeAddressInfo(() => OTHER_ADDRESS)
    await vi.waitFor(() => expect(first.safeInfo.value).not.toBeNull())
    await vi.waitFor(() => expect(second.safeInfo.value).not.toBeNull())

    const probedAddresses = new Set(client.calls.map(call => call.address.toLowerCase()))
    expect(probedAddresses).toEqual(new Set([SAFE_ADDRESS, OTHER_ADDRESS]))
  })
})
