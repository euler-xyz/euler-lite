import { WagmiPlugin } from '@wagmi/vue'
import { createAppKit } from '@reown/appkit/vue'
import type { AppKitNetwork } from '@reown/appkit/networks'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { getNetworksByChainIds } from '~/entities/chainRegistry'

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

  const customRpcUrls: Record<string, { url: string }[]> = {}
  for (const chainId of enabledChainIds) {
    customRpcUrls[`eip155:${chainId}`] = [{ url: `/api/rpc/${chainId}` }]
  }

  const wagmiAdapter = new WagmiAdapter({
    networks,
    projectId: projectId || '',
    customRpcUrls,
  })

  createAppKit({
    adapters: [wagmiAdapter],
    networks,
    projectId: projectId || '',
    metadata,
    themeVariables: {
      '--w3m-font-family': 'inherit',
    },
  })

  nuxtApp.vueApp.use(WagmiPlugin, { config: wagmiAdapter.wagmiConfig })
})
