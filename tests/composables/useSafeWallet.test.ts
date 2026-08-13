import { beforeEach, describe, expect, it, vi } from 'vitest'

const wagmiMocks = vi.hoisted(() => ({
  config: {},
  getAccount: vi.fn(),
  watchAccount: vi.fn(),
}))

vi.mock('@wagmi/vue', () => ({
  useConfig: () => wagmiMocks.config,
}))

vi.mock('@wagmi/vue/actions', () => ({
  getAccount: wagmiMocks.getAccount,
  watchAccount: wagmiMocks.watchAccount,
}))

const safeConnector = {
  id: 'safe',
  name: 'Safe',
  getProvider: async () => ({ request: vi.fn() }),
}

const injectedConnector = {
  id: 'io.metamask',
  name: 'MetaMask',
  getProvider: async () => ({ request: vi.fn() }),
}

const importComposable = async () => {
  const { useSafeWallet } = await import('~/composables/useSafeWallet')
  return useSafeWallet
}

describe('useSafeWallet', () => {
  beforeEach(() => {
    vi.resetModules()
    wagmiMocks.getAccount.mockReset()
    wagmiMocks.watchAccount.mockReset()
  })

  it('reports true for the Safe iframe connector', async () => {
    wagmiMocks.getAccount.mockReturnValue({ connector: safeConnector })
    const useSafeWallet = await importComposable()

    const { isSafeWallet, isSafeWalletResolved } = useSafeWallet()
    expect(isSafeWalletResolved.value).toBe(false)
    await vi.waitFor(() => expect(isSafeWallet.value).toBe(true))
    expect(isSafeWalletResolved.value).toBe(true)
  })

  it('reports false for regular connectors and no connector', async () => {
    wagmiMocks.getAccount.mockReturnValue({ connector: injectedConnector })
    const useSafeWallet = await importComposable()

    const { isSafeWallet } = useSafeWallet()
    // Detection resolves asynchronously; give it a macrotask.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(isSafeWallet.value).toBe(false)
  })

  it('follows connector changes through the wagmi account watcher', async () => {
    wagmiMocks.getAccount.mockReturnValue({ connector: undefined })
    const useSafeWallet = await importComposable()

    const { isSafeWallet } = useSafeWallet()
    expect(wagmiMocks.watchAccount).toHaveBeenCalledTimes(1)
    const { onChange } = wagmiMocks.watchAccount.mock.calls[0][1]

    onChange({ connector: safeConnector })
    await vi.waitFor(() => expect(isSafeWallet.value).toBe(true))

    onChange({ connector: injectedConnector })
    await vi.waitFor(() => expect(isSafeWallet.value).toBe(false))

    onChange({ connector: undefined })
    expect(isSafeWallet.value).toBe(false)
  })

  it('discards stale detections after a rapid connector switch', async () => {
    wagmiMocks.getAccount.mockReturnValue({ connector: undefined })
    let releaseSafeProvider!: (value: { request: () => void }) => void
    const slowSafeConnector = {
      id: 'safe',
      name: 'Safe',
      getProvider: () => new Promise<{ request: () => void }>((resolve) => {
        releaseSafeProvider = resolve
      }),
    }
    const useSafeWallet = await importComposable()

    const { isSafeWallet } = useSafeWallet()
    const { onChange } = wagmiMocks.watchAccount.mock.calls[0][1]

    onChange({ connector: slowSafeConnector })
    // The user switches away before Safe detection resolves.
    onChange({ connector: injectedConnector })
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseSafeProvider({ request: () => {} })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(isSafeWallet.value).toBe(false)
  })

  it('fails closed when an identifiably Safe connector cannot provide its provider', async () => {
    const brokenSafeConnector = {
      id: 'safe',
      name: 'Safe',
      getProvider: async () => {
        throw new Error('provider unavailable')
      },
    }
    wagmiMocks.getAccount.mockReturnValue({ connector: brokenSafeConnector })
    const useSafeWallet = await importComposable()

    const { isSafeWallet, isSafeWalletResolved } = useSafeWallet()
    await vi.waitFor(() => expect(isSafeWalletResolved.value).toBe(true))
    // The connector says Safe by identity — provider failure must not
    // reclassify it as a regular wallet and re-enable signatures.
    expect(isSafeWallet.value).toBe(true)
  })

  it('clears a previous Safe answer the moment the connector changes', async () => {
    wagmiMocks.getAccount.mockReturnValue({ connector: safeConnector })
    let releaseProvider!: (value: { request: () => void }) => void
    const slowEoaConnector = {
      id: 'walletconnect',
      name: 'WalletConnect',
      getProvider: () => new Promise<{ request: () => void }>((resolve) => {
        releaseProvider = resolve
      }),
    }
    const useSafeWallet = await importComposable()

    const { isSafeWallet, isSafeWalletResolved } = useSafeWallet()
    await vi.waitFor(() => expect(isSafeWallet.value).toBe(true))

    // Safe → slow EOA connector: the stale Safe answer must drop
    // synchronously, not linger through the new connector's detection.
    const { onChange } = wagmiMocks.watchAccount.mock.calls[0][1]
    onChange({ connector: slowEoaConnector })
    expect(isSafeWallet.value).toBe(false)
    expect(isSafeWalletResolved.value).toBe(false)

    releaseProvider({ request: () => {} })
    await vi.waitFor(() => expect(isSafeWalletResolved.value).toBe(true))
    expect(isSafeWallet.value).toBe(false)
  })

  it('reports unresolved while detection for the current connector is pending', async () => {
    wagmiMocks.getAccount.mockReturnValue({ connector: undefined })
    let releaseProvider!: (value: { request: () => void }) => void
    const slowConnector = {
      id: 'walletconnect',
      name: 'WalletConnect',
      getProvider: () => new Promise<{ request: () => void }>((resolve) => {
        releaseProvider = resolve
      }),
    }
    const useSafeWallet = await importComposable()

    const { isSafeWalletResolved } = useSafeWallet()
    // No connector resolves immediately.
    await vi.waitFor(() => expect(isSafeWalletResolved.value).toBe(true))

    const { onChange } = wagmiMocks.watchAccount.mock.calls[0][1]
    onChange({ connector: slowConnector })
    expect(isSafeWalletResolved.value).toBe(false)

    releaseProvider({ request: () => {} })
    await vi.waitFor(() => expect(isSafeWalletResolved.value).toBe(true))
  })

  it('initializes the account watcher only once across calls', async () => {
    wagmiMocks.getAccount.mockReturnValue({ connector: undefined })
    const useSafeWallet = await importComposable()

    useSafeWallet()
    useSafeWallet()
    expect(wagmiMocks.watchAccount).toHaveBeenCalledTimes(1)
  })
})
