import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  adapterOptions: [] as Record<string, unknown>[],
  appKitOptions: [] as Record<string, unknown>[],
  baseAccount: vi.fn((options: unknown) => ({ connector: 'baseAccount', options })),
  coinbaseWallet: vi.fn((options: unknown) => ({ connector: 'coinbaseWallet', options })),
}))

vi.mock('@reown/appkit/vue', () => ({
  createAppKit: (options: Record<string, unknown>) => {
    mocks.appKitOptions.push(options)
    return { open: vi.fn(), ready: vi.fn(async () => undefined) }
  },
}))
vi.mock('@reown/appkit-adapter-wagmi', () => ({
  WagmiAdapter: class {
    wagmiConfig = {}
    constructor(options: Record<string, unknown>) {
      mocks.adapterOptions.push(options)
    }
  },
}))
vi.mock('@wagmi/vue', () => ({ WagmiPlugin: {} }))
vi.mock('@wagmi/vue/connectors', () => ({ baseAccount: mocks.baseAccount, coinbaseWallet: mocks.coinbaseWallet }))
vi.mock('~/entities/chainRegistry', () => ({
  getNetworksByChainIds: () => [{ id: 1, rpcUrls: { default: { http: ['https://rpc.example'] } } }],
}))
vi.mock('~/utils/base-app-wallet', () => ({ hasBaseAppInjectedProvider: () => false }))

describe('the Coinbase Wallet and Base Account connectors', () => {
  beforeEach(() => {
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin)
    vi.stubGlobal('useEnvConfig', () => ({ appDescription: '', appKitProjectId: 'project', appTitle: 'Euler', appUrl: 'https://app.example' }))
    vi.stubGlobal('useChainConfig', () => ({ enabledChainIds: [1] }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('are created with the SDKs\' telemetry off, in place of AppKit\'s defaults that leave it on', async () => {
    const { default: plugin } = await import('~/plugins/00.wagmi')
    ;(plugin as unknown as (app: unknown) => unknown)({ vueApp: { use: vi.fn() } })
    expect(mocks.coinbaseWallet).toHaveBeenCalledWith({ preference: { options: 'all', telemetry: false } })
    expect(mocks.baseAccount).toHaveBeenCalledWith({ preference: { telemetry: false } })
    expect(mocks.adapterOptions[0]!.connectors).toEqual([
      { connector: 'coinbaseWallet', options: { preference: { options: 'all', telemetry: false } } },
      { connector: 'baseAccount', options: { preference: { telemetry: false } } },
    ])
    expect(mocks.appKitOptions[0]).toMatchObject({ enableBaseAccount: false, enableCoinbase: false })
  })
})
