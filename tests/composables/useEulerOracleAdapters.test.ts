import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'

const { fetchOracleAdapterMap } = vi.hoisted(() => ({
  fetchOracleAdapterMap: vi.fn(),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: async () => ({ oracleAdapterService: { fetchOracleAdapterMap } }),
}))

const KNOWN_ADAPTER = '0x0000000000000000000000000000000000000001'
const UNLISTED_ADAPTER = '0x0000000000000000000000000000000000000002'

describe('useEulerOracleAdapters', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('loads the adapter map once per chain and serves later misses from the loaded map', async () => {
    fetchOracleAdapterMap.mockResolvedValue({
      [KNOWN_ADAPTER]: { oracle: KNOWN_ADAPTER, name: 'Known' },
    })
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter } = useEulerOracleAdapters()

    const known = await loadOracleAdapter(1, KNOWN_ADAPTER)
    expect(known?.name).toBe('Known')
    expect(fetchOracleAdapterMap).toHaveBeenCalledTimes(1)

    // A miss on an already-loaded chain must not refetch: the dataset is
    // fetched whole per chain, so reloading cannot surface an unlisted
    // adapter — and the rewrite of the store would re-trigger every
    // subscriber (regression: infinite update loop freezing the explore page
    // for markets whose custom adapters are absent from the dataset).
    const missing = await loadOracleAdapter(1, UNLISTED_ADAPTER)
    expect(missing).toBeUndefined()
    expect(fetchOracleAdapterMap).toHaveBeenCalledTimes(1)
  })

  it('reloads when the chain changes', async () => {
    fetchOracleAdapterMap.mockResolvedValue({})
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadAllOracleAdapters } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    await loadAllOracleAdapters(1)
    expect(fetchOracleAdapterMap).toHaveBeenCalledTimes(1)

    await loadAllOracleAdapters(2)
    expect(fetchOracleAdapterMap).toHaveBeenCalledTimes(2)
  })

  it('does not subscribe the calling effect to adapter loads', async () => {
    // Calling useEulerOracleAdapters() inside a computed (e.g. via
    // useEulerLabels() deep in the market-groups pipeline) must not make that
    // computed a subscriber of the adapter store. The shared reactive view is
    // built once at module scope because toReactive()'s reactive() wrapper
    // performs a property read through the proxy at construction time, which
    // would otherwise register the currently-running effect as a dependent.
    fetchOracleAdapterMap.mockResolvedValue({
      [KNOWN_ADAPTER]: { oracle: KNOWN_ADAPTER, name: 'Known' },
    })
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')

    let evaluations = 0
    const bystander = computed(() => {
      useEulerOracleAdapters()
      return ++evaluations
    })
    expect(bystander.value).toBe(1)

    await useEulerOracleAdapters().loadAllOracleAdapters(1)
    expect(bystander.value).toBe(1)

    // Actual readers of the map still react to the load.
    const { oracleAdapters } = useEulerOracleAdapters()
    expect(oracleAdapters[KNOWN_ADAPTER]?.name).toBe('Known')
  })
})
