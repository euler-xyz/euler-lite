import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { createAppKit } from '@reown/appkit/vue'
import type { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { ChainController, ConnectorController, OptionsController, RouterController } from '@reown/appkit-controllers'

const COINBASE_WALLET_ID = 'd0ca99ff52b99abc48743dad0f7fc891e041be73574f7fac4afe5d4bb83845c8'
const APP_URL = 'https://app.example/portfolio'
const storage = new Map<string, string>()

const mocks = vi.hoisted(() => ({
  appKitOptions: undefined as Parameters<typeof createAppKit>[0] | undefined,
}))

vi.mock('@reown/appkit/vue', () => ({
  createAppKit: (options: Parameters<typeof createAppKit>[0]) => {
    mocks.appKitOptions = options
    return { open: vi.fn(), ready: vi.fn(async () => undefined) }
  },
}))
vi.mock('@wagmi/vue', () => ({ WagmiPlugin: {} }))
vi.mock('~/entities/chainRegistry', async () => {
  const { mainnet } = await import('@reown/appkit/networks')
  return { getNetworksByChainIds: () => [mainnet] }
})
vi.mock('~/utils/base-app-wallet', () => ({ hasBaseAppInjectedProvider: () => false }))

const initializeConnectors = async () => {
  const { default: plugin } = await import('~/plugins/00.wagmi')
  ;(plugin as unknown as (app: unknown) => unknown)({ vueApp: { use: vi.fn() } })
  const options = mocks.appKitOptions!
  // Apply the captured AppKit options to the real adapter without remote project initialization.
  OptionsController.setEnableCoinbase(options.enableCoinbase !== false)
  OptionsController.setEnableBaseAccount(options.enableBaseAccount !== false)
  OptionsController.setCoinbasePreference(options.coinbasePreference)
  OptionsController.setEnableInjected(false)
  OptionsController.setFeatures({ email: false, socials: [] })
  const adapter = options.adapters![0] as WagmiAdapter
  await adapter.syncConnectors()
  ConnectorController.setConnectors(adapter.connectors)
  return adapter
}

describe('the Coinbase Wallet and Base Account connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appKitOptions = undefined
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    vi.stubGlobal('coinbaseWalletExtension', { setAppInfo: vi.fn() })
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin)
    vi.stubGlobal('useEnvConfig', () => ({ appDescription: '', appKitProjectId: 'project', appTitle: 'Euler', appUrl: APP_URL }))
    vi.stubGlobal('useChainConfig', () => ({ enabledChainIds: [1] }))
    ChainController.state.activeChain = 'eip155'
    ConnectorController.state.allConnectors = []
    ConnectorController.state.connectors = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    ConnectorController.state.allConnectors = []
    ConnectorController.state.connectors = []
  })

  it('registers one connector per wallet and passes telemetry suppression through the real adapter and connector factories', async () => {
    const adapter = await initializeConnectors()
    const coinbase = adapter.wagmiConfig.connectors.filter(connector => connector.type === 'coinbaseWallet')
    const base = adapter.wagmiConfig.connectors.filter(connector => connector.id === 'baseAccount')
    expect(coinbase).toHaveLength(1)
    expect(base).toHaveLength(1)
    await coinbase[0]!.getProvider()
    await base[0]!.getProvider()
    const preferences = [...storage.values()].map(value => JSON.parse(value).state?.config?.preference).filter(Boolean)
    expect(preferences).toHaveLength(2)
    expect(preferences).toEqual([
      { options: 'all', telemetry: false },
      { options: 'all', telemetry: false },
    ])
  })

  it.each([true, false])('preserves Coinbase wallet-list navigation with extension present: %s', async (extensionPresent) => {
    await initializeConnectors()
    const navigate = vi.fn()
    vi.stubGlobal('window', {
      ...(extensionPresent ? { coinbaseWalletExtension: {} } : {}),
      location: {
        get href() { return APP_URL },
        set href(value: string) { navigate(value) },
      },
    })
    const route = vi.spyOn(RouterController, 'push').mockImplementation(() => {})
    ConnectorController.selectWalletConnector({ id: COINBASE_WALLET_ID, name: 'Coinbase Wallet' })
    if (extensionPresent) expect(navigate).not.toHaveBeenCalled()
    else expect(navigate).toHaveBeenCalledExactlyOnceWith(`cbwallet://miniapp?url=${encodeURIComponent(APP_URL)}`)
    expect(route).toHaveBeenCalledWith('ConnectingExternal', expect.objectContaining({
      connector: expect.objectContaining({ id: 'coinbaseWalletSDK' }),
    }))
  })
})
