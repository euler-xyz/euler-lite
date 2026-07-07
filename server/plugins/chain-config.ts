/**
 * Nitro plugin that scans process.env for chain-related env vars
 * and injects the computed config into the HTML via render:html hook.
 *
 * This runs at server startup, so Doppler-injected env vars are available.
 * The config is embedded as a <script> tag in the HTML head, making it
 * accessible to the client synchronously via window.__CHAIN_CONFIG__.
 */
import { parseChainIds } from '../../utils/parseChainIds'
import { getChainEnvIssues, getConfiguredChainIds, getEnabledChainIds } from '~/utils/chain-env'
import { getUnknownChainIds } from '~/entities/chainRegistry'
import { logger } from '~/server/utils/logger'
import { parseEVaultFetchChunkChainIds } from '~/utils/eVaultFetchChunkConfig'

export default defineNitroPlugin((nitroApp) => {
  const configuredChainIds = getConfiguredChainIds()
  const unknownChainIds = getUnknownChainIds(configuredChainIds)
  const chainEnvIssues = getChainEnvIssues()
  if (unknownChainIds.length) {
    logger.error(
      { ctx: 'chain-config', chainIds: unknownChainIds },
      'ignoring unsupported chain IDs from RPC_URL_<chainId> env vars; add only chains exported by @reown/appkit/networks',
    )
  }
  if (chainEnvIssues.emptyRpcUrlChainIds.length) {
    logger.error(
      { ctx: 'chain-config', chainIds: chainEnvIssues.emptyRpcUrlChainIds },
      'ignoring empty RPC_URL_<chainId> env vars; set a valid HTTP(S) RPC URL or remove the env var',
    )
  }
  if (chainEnvIssues.malformedRpcUrlChainIds.length) {
    logger.error(
      { ctx: 'chain-config', chainIds: chainEnvIssues.malformedRpcUrlChainIds },
      'ignoring malformed RPC_URL_<chainId> env vars; set a valid HTTP(S) RPC URL',
    )
  }

  const enabledChainIds = getEnabledChainIds()

  const enabledSet = new Set(enabledChainIds)
  const deprecatedChainIds = parseChainIds(process.env.DEPRECATED_CHAINS, enabledSet)
  const onchainSdkChainIds = parseChainIds(process.env.ONCHAIN_SDK_CHAINS, enabledSet)
  const eVaultFetchChunkChainIds = parseEVaultFetchChunkChainIds(process.env, enabledSet)

  const scriptTag = `<script>window.__CHAIN_CONFIG__=${JSON.stringify({ enabledChainIds, deprecatedChainIds, onchainSdkChainIds, eVaultFetchChunkChainIds, unsupportedChainIds: unknownChainIds, chainEnvIssues })}</script>`

  nitroApp.hooks.hook('render:html', (html) => {
    html.head.push(scriptTag)
  })
})
