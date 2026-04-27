import { WagmiPlugin } from '@wagmi/vue'
import { fallback, http, type Transport } from 'viem'
import { createAppKit } from '@reown/appkit/vue'
import type { AppKitNetwork } from '@reown/appkit/networks'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { getNetworksByChainIds } from '~/entities/chainRegistry'
import { hasBaseAppInjectedProvider } from '~/utils/base-app-wallet'

// Base docs Reown wallet listing ID for featuring Base Account in AppKit.
const BASE_ACCOUNT_WALLET_ID = 'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa'

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
  const ensureAppKit = () => {
    if (appKitInstance) return appKitInstance
    const isBaseApp = hasBaseAppInjectedProvider()
    appKitInstance = createAppKit({
      adapters: [wagmiAdapter],
      networks,
      projectId: projectId || '',
      metadata,
      themeVariables: {
        '--w3m-font-family': 'inherit',
      },
      ...(isBaseApp
        ? {
            featuredWalletIds: [BASE_ACCOUNT_WALLET_ID],
            allWallets: 'SHOW' as const,
          }
        : {}),
    })
    return appKitInstance
  }

  const openWalletModal = async () => {
    const kit = ensureAppKit()
    await kit.ready()
    kit.open()
  }

  // Always eagerly initialize AppKit so chunk loads and initialization
  // side-effects (connector discovery, remote feature fetches) complete
  // during page load rather than on first "Connect Wallet" click.
  // Previously this was deferred for first-time visitors to avoid Phantom's
  // unsolicited connection prompt, but that auto-connect is a pre-existing
  // wagmi-level behavior unrelated to AppKit initialization.
  ensureAppKit()

  return {
    provide: {
      ensureAppKit,
      openWalletModal,
    },
  }
})
