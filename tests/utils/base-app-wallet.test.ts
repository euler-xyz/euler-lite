import { describe, expect, it } from 'vitest'
import { hasBaseAppInjectedProvider, selectBaseAppConnector } from '~/utils/base-app-wallet'

const provider = (flags: Record<string, unknown> = {}) => ({
  request: async () => undefined,
  ...flags,
})

describe('base-app-wallet', () => {
  it('detects a Base App injected provider from provider hints', () => {
    expect(hasBaseAppInjectedProvider(provider({ isBase: true }), 'Mozilla/5.0')).toBe(true)
    expect(hasBaseAppInjectedProvider(provider({ isCoinbaseBrowser: true }), 'Mozilla/5.0')).toBe(true)
  })

  it('does not treat desktop Coinbase Wallet as Base App', () => {
    expect(hasBaseAppInjectedProvider(provider({ isCoinbaseWallet: true }), 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120')).toBe(false)
  })

  it('detects a mobile in-app browser only when an injected provider exists', () => {
    const userAgent = 'Mozilla/5.0 (iPhone) AppleWebKit Mobile Base'

    expect(hasBaseAppInjectedProvider(provider(), userAgent)).toBe(false)
    expect(hasBaseAppInjectedProvider(provider({ isCoinbaseWallet: true }), 'Mozilla/5.0 (iPhone) AppleWebKit Mobile Coinbase')).toBe(true)
    expect(hasBaseAppInjectedProvider(undefined, userAgent)).toBe(false)
  })

  it('does not treat generic mobile wallet webviews as Base App', () => {
    const userAgent = 'Mozilla/5.0 (iPhone) AppleWebKit Mobile Wallet WebView'

    expect(hasBaseAppInjectedProvider(provider(), userAgent)).toBe(false)
  })

  it('does not treat normal desktop injected wallets as Base App', () => {
    expect(hasBaseAppInjectedProvider(provider(), 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120')).toBe(false)
  })

  it('prefers the injected connector for in-app provider connections', () => {
    const connectors = [
      { id: 'walletConnect', name: 'WalletConnect' },
      { id: 'coinbaseWalletSDK', name: 'Coinbase Wallet' },
      { id: 'baseAccount', name: 'Base Account' },
      { id: 'injected', name: 'Injected' },
    ]

    expect(selectBaseAppConnector(connectors)).toEqual(connectors[3])
    expect(selectBaseAppConnector(connectors.slice(0, 3))).toEqual(connectors[1])
    expect(selectBaseAppConnector([connectors[0], connectors[2]])).toEqual(connectors[2])
  })
})
