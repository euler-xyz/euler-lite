/**
 * Nitro plugin that scans process.env for chain-related env vars
 * and injects the computed config into the HTML via render:html hook.
 *
 * This runs at server startup, so Doppler-injected env vars are available.
 * The config is embedded as a <script> tag in the HTML head, making it
 * accessible to the client synchronously via window.__CHAIN_CONFIG__.
 */
import { parseDeprecatedChains } from '../../utils/parseDeprecatedChains'
import { getConfiguredChainIds, getEnabledChainIds, getSubgraphUris } from '~/utils/chain-env'
import { getUnknownChainIds } from '~/entities/chainRegistry'

export default defineNitroPlugin((nitroApp) => {
  const configuredChainIds = getConfiguredChainIds()
  const unknownChainIds = getUnknownChainIds(configuredChainIds)
  if (unknownChainIds.length) {
    console.warn(
      `[chainConfig] Ignoring unsupported chain IDs from RPC_URL_<chainId> env vars: ${unknownChainIds.join(', ')}. Add only chains exported by @reown/appkit/networks.`,
    )
  }

  const enabledChainIds = getEnabledChainIds()
  const subgraphUris = getSubgraphUris()

  const enabledSet = new Set(enabledChainIds)
  const deprecatedChainIds = parseDeprecatedChains(process.env.DEPRECATED_CHAINS, enabledSet)

  const scriptTag = `<script>window.__CHAIN_CONFIG__=${JSON.stringify({ enabledChainIds, deprecatedChainIds, subgraphUris })}</script>`

  nitroApp.hooks.hook('render:html', (html) => {
    html.head.push(scriptTag)
  })
})
