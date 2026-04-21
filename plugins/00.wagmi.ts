import { WagmiPlugin } from '@wagmi/vue'
import { fallback, http, type Transport } from 'viem'
import { createAppKit } from '@reown/appkit/vue'
import type { AppKitNetwork } from '@reown/appkit/networks'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { getNetworksByChainIds } from '~/entities/chainRegistry'

/**
 * Detects whether the user has previously connected a wallet on this origin.
 *
 * AppKit / Wagmi eagerly probe injected providers and attempt silent reconnect
 * at startup. For users in "default EVM wallet" modes (notably Phantom), that
 * probe can surface an unsolicited connection prompt on every page visit — even
 * when the visitor has never connected. To avoid that we only eagerly initialize
 * AppKit when we know the user previously connected. Otherwise we defer AppKit
 * creation until the user explicitly clicks "Connect Wallet".
 */
const hasPersistedWalletSession = (): boolean => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return false
  }

  try {
    if (window.localStorage.getItem('wagmi.recentConnectorId')) {
      return true
    }

    const storeRaw = window.localStorage.getItem('wagmi.store')
    if (storeRaw) {
      try {
        const parsed = JSON.parse(storeRaw)
        if (parsed?.state?.current) return true
      }
      catch {
        // Malformed store — treat as no session.
      }
    }
  }
  catch {
    // localStorage may be blocked (Safari private mode, etc.) — treat as no session.
  }

  return false
}

export default defineNuxtPlugin((nuxtApp) => {
  const envConfig = useEnvConfig()
  const projectId = envConfig.appKitProjectId
  const appUrl = envConfig.appUrl
  const normalizedAppUrl = appUrl ? appUrl.replace(/\/+$/, '') : ''
  const { enabledChainIds } = useChainConfig()

  if (!projectId) {
    console.warn('[wagmi] Missing APPKIT_PROJECT_ID in runtime config')
  }
  if (!normalizedAppUrl) {
    console.warn('[wagmi] Missing APP_URL in runtime config')
  }

  if (!enabledChainIds.length) {
    throw new Error(
      '[wagmi] No enabled chains. Set at least one RPC_URL_HTTP_<chainId> env var.',
    )
  }

  const networks = getNetworksByChainIds(enabledChainIds) as [
    AppKitNetwork,
    ...AppKitNetwork[],
  ]

  const metadata = {
    name: envConfig.appTitle,
    description: envConfig.appDescription,
    url: normalizedAppUrl,
    icons: normalizedAppUrl ? [`${normalizedAppUrl}/manifest-img.png`] : [],
  }

  // Explicit transports per chain: proxy first, chain's default public RPC as
  // fallback. Using `transports` (not `customRpcUrls`) lets us cap the outer
  // fallback retryCount at 0 — otherwise viem retries the whole [proxy, public]
  // cycle 3× by default, turning one 429 into 8 HTTP requests.
  //
  // On Reown-supported chains AppKit still wraps this in an outer fallback
  // with its own Blockchain API (see extendWagmiTransports in appkit-utils);
  // that's additive and fine.
  const transports: Record<number, Transport> = {}
  const batchConfig = { batch: { batchSize: 100, wait: 100 } }
  for (const network of networks) {
    const chainId = Number(network.id)
    const publicHttp = network.rpcUrls?.default?.http ?? []
    transports[chainId] = fallback(
      [
        http(`/api/rpc/${chainId}`, batchConfig),
        // Public fallback gets the same batch config so a proxy outage doesn't
        // explode into 50-100× more individual requests to the public endpoint.
        ...publicHttp.map(url => http(url, batchConfig)),
      ],
      { retryCount: 0 },
    )
  }

  const wagmiAdapter = new WagmiAdapter({
    networks,
    projectId: projectId || '',
    transports,
  })

  nuxtApp.vueApp.use(WagmiPlugin, { config: wagmiAdapter.wagmiConfig })

  let appKitInstance: ReturnType<typeof createAppKit> | null = null
  let _isAppKitInitializing = false
  const ensureAppKit = () => {
    if (appKitInstance) return appKitInstance
    appKitInstance = createAppKit({
      adapters: [wagmiAdapter],
      networks,
      projectId: projectId || '',
      metadata,
      themeVariables: {
        '--w3m-font-family': 'inherit',
      },
    })
    return appKitInstance
  }

  const openWalletModal = async () => {
    _isAppKitInitializing = true
    const kit = ensureAppKit()
    await kit.ready()
    _isAppKitInitializing = false
    kit.open()
  }

  // Returning users who previously connected get the full modal up front so
  // silent reconnect works as before. First-time / signed-out visitors don't
  // pay that cost until they actually ask to connect.
  if (hasPersistedWalletSession()) {
    ensureAppKit()
  }

  return {
    provide: {
      ensureAppKit,
      openWalletModal,
      isAppKitInitializing: () => _isAppKitInitializing,
    },
  }
})
