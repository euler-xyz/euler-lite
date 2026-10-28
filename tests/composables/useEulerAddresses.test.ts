import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getEulerSdk: vi.fn() }))

vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdk: mocks.getEulerSdk }))
vi.mock('~/utils/errorHandling', () => ({ logWarn: vi.fn() }))

const deploymentService = (chainIds: number[]) => ({
  getDeploymentChainIds: () => chainIds,
  getDeployment: (chainId: number) => ({ chainId }),
})

describe('useEulerAddresses deployment admission', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getEulerSdk.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shrinks the initial env list and selects an admitted chain after delayed registry loading', async () => {
    vi.stubGlobal('useChainConfig', () => ({ enabledChainIds: [999999, 8453, 1] }))
    let resolve!: (sdk: { deploymentService: ReturnType<typeof deploymentService> }) => void
    mocks.getEulerSdk.mockImplementation(() => new Promise((answer) => {
      resolve = answer
    }))
    const { useEulerAddresses } = await import('~/composables/useEulerAddresses')
    const state = useEulerAddresses()
    const loading = state.loadEulerConfig()
    expect(state.chainId.value).toBe(999999)
    await vi.waitFor(() => expect(mocks.getEulerSdk).toHaveBeenCalledOnce())

    resolve({ deploymentService: deploymentService([1, 137, 8453]) })
    await loading

    expect(state.allowedChainIds.value).toEqual([8453, 1])
    expect(state.chainId.value).toBe(8453)
    expect(state.eulerChainsConfig.value).toEqual([{ chainId: 1 }, { chainId: 8453 }])
    expect(state.isReady.value).toBe(true)
    state.changeCurrentChainId(999999)
    expect(state.chainId.value).toBe(8453)
  })

  it('does not fall back to unconfigured deployments when the intersection is empty', async () => {
    vi.stubGlobal('useChainConfig', () => ({ enabledChainIds: [999999] }))
    mocks.getEulerSdk.mockResolvedValue({ deploymentService: deploymentService([1]) })
    const { useEulerAddresses } = await import('~/composables/useEulerAddresses')
    const state = useEulerAddresses()
    await state.loadEulerConfig()

    expect(state.allowedChainIds.value).toEqual([])
    expect(state.chainId.value).toBe(0)
    expect(state.eulerChainsConfig.value).toEqual([])
    expect(state.isReady.value).toBe(false)
    expect(state.error.value).toBe('No enabled chains have usable deployment metadata')
  })
})
