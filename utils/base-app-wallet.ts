interface Eip1193Provider {
  request?: (...args: unknown[]) => Promise<unknown>
  isBase?: boolean
  isCoinbaseWallet?: boolean
  isCoinbaseBrowser?: boolean
  providers?: Eip1193Provider[]
}

interface WalletConnectorLike {
  id?: string
  name?: string
}

const hasRequest = (provider: unknown): provider is Eip1193Provider =>
  Boolean(provider && typeof provider === 'object' && typeof (provider as Eip1193Provider).request === 'function')

const getEthereumProviders = (ethereum: unknown): Eip1193Provider[] => {
  if (!hasRequest(ethereum)) return []

  const providers = Array.isArray(ethereum.providers)
    ? ethereum.providers.filter(hasRequest)
    : []

  return providers.length ? providers : [ethereum]
}

const isMobileInAppBrowser = (userAgent: string): boolean => {
  const normalized = userAgent.toLowerCase()
  const isMobile = /android|iphone|ipad|ipod/.test(normalized)
  if (!isMobile) return false

  return /base|coinbase|cbwallet/.test(normalized)
}

const hasBaseProviderHint = (provider: Eip1193Provider): boolean =>
  provider.isBase === true
  || provider.isCoinbaseBrowser === true

export const hasBaseAppInjectedProvider = (
  ethereum: unknown = typeof window === 'undefined' ? undefined : (window as unknown as { ethereum?: unknown }).ethereum,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean => {
  const providers = getEthereumProviders(ethereum)
  if (!providers.length) return false

  if (providers.some(hasBaseProviderHint)) return true

  return providers.some(provider => provider.isCoinbaseWallet === true) && isMobileInAppBrowser(userAgent)
}

export const selectBaseAppConnector = <TConnector extends WalletConnectorLike>(
  connectors: readonly TConnector[],
): TConnector | undefined => {
  const scored = connectors
    .map((connector, index) => {
      const haystack = `${connector.id ?? ''} ${connector.name ?? ''}`.toLowerCase()
      const compact = haystack.replace(/[^a-z0-9]/g, '')
      const score = compact.includes('injected')
        ? 100
        : compact.includes('coinbase')
          ? 80
          : compact.includes('baseaccount')
            ? 60
            : compact.includes('base')
              ? 50
              : 0
      return { connector, index, score }
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  return scored[0]?.connector
}
