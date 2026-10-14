import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enabledChainIds: [1, 137, 146, 8453],
  loadEulerChains: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  peekEulerChains: vi.fn((): unknown[] | undefined => undefined),
}))

vi.mock('~/utils/chain-env', () => ({
  getConfiguredChainIds: () => mocks.enabledChainIds,
  getEnabledChainIds: () => mocks.enabledChainIds,
  getChainEnvIssues: () => ({ emptyRpcUrlChainIds: [], malformedRpcUrlChainIds: [] }),
}))

vi.mock('~/server/api/internal/euler-chains.get', () => ({
  loadEulerChains: mocks.loadEulerChains,
  peekEulerChains: mocks.peekEulerChains,
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const REGISTRY = [
  { chainId: 1, status: 'production', explorerUrl: 'https://etherscan.io/' },
  { chainId: 137, status: 'unlisted', explorerUrl: 'https://polygonscan.com' },
  { chainId: 146, status: 'deprecated' },
  { chainId: 8453, status: 'staging', explorerUrl: 'https://basescan.org' },
]

type Hook = (...args: unknown[]) => unknown

interface InjectedChainConfig {
  enabledChainIds: number[]
  deprecatedChainIds: number[]
  onchainSdkChainIds: number[]
  explorerUrls: Record<string, string>
}

const bootPlugin = async () => {
  vi.resetModules()
  const { default: plugin } = await import('~/server/plugins/chain-config')
  const hooks = new Map<string, Hook>()
  plugin({ hooks: { hook: (name: string, fn: Hook) => hooks.set(name, fn) } } as never)
  const renderHtml = async () => {
    const html = { head: [] as string[] }
    await hooks.get('render:html')!(html)
    return html.head.join('')
  }
  const render = async (): Promise<InjectedChainConfig> => {
    const match = (await renderHtml()).match(/<script>window\.__CHAIN_CONFIG__=(.*)<\/script>/)
    return JSON.parse(match![1]!)
  }
  return { render }
}

describe('chain-config plugin registry status', () => {
  beforeEach(() => {
    mocks.peekEulerChains.mockReturnValue(REGISTRY)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    mocks.loadEulerChains.mockReset().mockImplementation(() => Promise.resolve([]))
    mocks.peekEulerChains.mockReset().mockReturnValue(undefined)
  })

  it('hides unlisted chains and keeps staging chains outside production', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'stg')
    const { render } = await bootPlugin()

    const config = await render()
    expect(config.enabledChainIds).toEqual([1, 146, 8453])
    expect(config.explorerUrls).toEqual({ 1: 'https://etherscan.io', 8453: 'https://basescan.org' })
  })

  it('keeps staging chains when DOPPLER_ENVIRONMENT is unset', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', '')
    const { render } = await bootPlugin()

    expect((await render()).enabledChainIds).toEqual([1, 146, 8453])
  })

  it('hides staging chains in production', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const { render } = await bootPlugin()

    const config = await render()
    expect(config.enabledChainIds).toEqual([1, 146])
    expect(config.explorerUrls).toEqual({ 1: 'https://etherscan.io' })
  })

  it('marks a chain deprecated when DEPRECATED_CHAINS or the registry says so', async () => {
    vi.stubEnv('DEPRECATED_CHAINS', '1,137')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '137,146')
    const { render } = await bootPlugin()

    const config = await render()
    expect(config.deprecatedChainIds).toEqual([1, 146])
    expect(config.onchainSdkChainIds).toEqual([146])
  })

  it('falls back to the env-derived config when no manifest is cached', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('DEPRECATED_CHAINS', '146')
    mocks.peekEulerChains.mockReturnValue(undefined)
    const { render } = await bootPlugin()

    const config = await render()
    expect(config.enabledChainIds).toEqual([1, 137, 146, 8453])
    expect(config.deprecatedChainIds).toEqual([146])
    expect(config.explorerUrls).toEqual({})
  })

  it('reads the current registry on every render', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const { render } = await bootPlugin()
    expect((await render()).enabledChainIds).toEqual([1, 146])

    mocks.peekEulerChains.mockReturnValue(
      REGISTRY.map(entry => entry.chainId === 8453 ? { ...entry, status: 'production' } : entry),
    )
    expect((await render()).enabledChainIds).toEqual([1, 146, 8453])
  })

  it('starts loading the manifest at boot and holds the first render until it answers', async () => {
    let answer = () => {}
    mocks.peekEulerChains.mockReturnValue(undefined)
    mocks.loadEulerChains.mockImplementation(() => new Promise((resolve) => {
      answer = () => {
        mocks.peekEulerChains.mockReturnValue(REGISTRY)
        resolve(REGISTRY)
      }
    }))
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const { render } = await bootPlugin()
    expect(mocks.loadEulerChains).toHaveBeenCalledTimes(1)

    const config = render()
    answer()
    expect((await config).enabledChainIds).toEqual([1, 146])
  })

  it('renders the env-derived config when the boot read fails', async () => {
    mocks.peekEulerChains.mockReturnValue(undefined)
    mocks.loadEulerChains.mockImplementation(() => Promise.reject(new Error('upstream down')))
    const { render } = await bootPlugin()

    expect((await render()).enabledChainIds).toEqual([1, 137, 146, 8453])
  })

  it('stops waiting for a slow boot read after a bounded time', async () => {
    vi.useFakeTimers()
    mocks.peekEulerChains.mockReturnValue(undefined)
    mocks.loadEulerChains.mockImplementation(() => new Promise(() => {}))
    const { render } = await bootPlugin()

    const config = render()
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await config).enabledChainIds).toEqual([1, 137, 146, 8453])
  })
})
