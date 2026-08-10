import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ROUTER_ADDRESS = '0x00000000000000000000000000000000000000cc'
const GOVERNOR_ADDRESS = '0x00000000000000000000000000000000000000dd'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const stubEnvironment = (client: unknown) => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useRpcClient', () => ({ client: ref(client) }))
}

const importComposable = async () => {
  const { useOracleRouterGovernor } = await import('~/composables/useOracleRouterGovernor')
  return useOracleRouterGovernor
}

describe('useOracleRouterGovernor', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('resolves the router governor', async () => {
    const client = { readContract: vi.fn(async () => GOVERNOR_ADDRESS) }
    stubEnvironment(client)
    const useOracleRouterGovernor = await importComposable()

    const { governor } = useOracleRouterGovernor(() => ROUTER_ADDRESS)
    await vi.waitFor(() => expect(governor.value).toBeTruthy())
    expect(governor.value?.toLowerCase()).toBe(GOVERNOR_ADDRESS)
  })

  it('passes through the zero address for renounced governance', async () => {
    const client = { readContract: vi.fn(async () => ZERO_ADDRESS) }
    stubEnvironment(client)
    const useOracleRouterGovernor = await importComposable()

    const { governor } = useOracleRouterGovernor(() => ROUTER_ADDRESS)
    await vi.waitFor(() => expect(governor.value).toBe(ZERO_ADDRESS))
  })

  it('resolves null when the contract has no readable governor', async () => {
    const client = {
      readContract: vi.fn(async () => {
        throw new Error('execution reverted')
      }),
    }
    stubEnvironment(client)
    const useOracleRouterGovernor = await importComposable()

    const { governor } = useOracleRouterGovernor(() => ROUTER_ADDRESS)
    await vi.waitFor(() => expect(client.readContract).toHaveBeenCalled())
    await Promise.resolve()
    expect(governor.value).toBeNull()
  })

  it('stays undefined without a router address and never probes', async () => {
    const client = { readContract: vi.fn() }
    stubEnvironment(client)
    const useOracleRouterGovernor = await importComposable()

    const { governor } = useOracleRouterGovernor(() => null)
    await Promise.resolve()
    expect(governor.value).toBeUndefined()
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it('does not cache transport failures as "no governor"', async () => {
    const readContract = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP request failed'))
      .mockResolvedValue(GOVERNOR_ADDRESS)
    stubEnvironment({ readContract })
    const useOracleRouterGovernor = await importComposable()

    const first = useOracleRouterGovernor(() => ROUTER_ADDRESS)
    await vi.waitFor(() => expect(readContract).toHaveBeenCalled())
    // Macrotask flush so the failed probe fully settles and releases its
    // in-flight slot before the retry instance is created.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(first.governor.value).toBeUndefined()

    // A fresh instance retries because the transport failure was not cached.
    const second = useOracleRouterGovernor(() => ROUTER_ADDRESS)
    await vi.waitFor(() => expect(second.governor.value).toBeTruthy())
  })

  it('caches lookups across instances', async () => {
    const client = { readContract: vi.fn(async () => GOVERNOR_ADDRESS) }
    stubEnvironment(client)
    const useOracleRouterGovernor = await importComposable()

    const first = useOracleRouterGovernor(() => ROUTER_ADDRESS)
    await vi.waitFor(() => expect(first.governor.value).toBeTruthy())
    const second = useOracleRouterGovernor(() => ROUTER_ADDRESS)
    await vi.waitFor(() => expect(second.governor.value).toBeTruthy())
    expect(client.readContract).toHaveBeenCalledTimes(1)
  })
})
