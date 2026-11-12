import { loadEulerChains, peekEulerChains } from '../api/internal/euler-chains.get'
import { readChainEnvConfig } from '~/utils/chain-env'
import { readServerChainPolicy } from '~/server/utils/chain-policy'
import { loadV3ChainCatalog } from '~/server/utils/v3-chain-catalog'
import { escapeScriptJson } from '~/server/utils/escape-script-json'
import { logger } from '~/server/utils/logger'

const BOOT_READ_WAIT_MS = 1_000

const delay = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export default defineNitroPlugin((nitroApp) => {
  const envChainConfig = readChainEnvConfig()
  const { unsupportedChainIds: unknownChainIds, chainEnvIssues } = envChainConfig
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

  // Prerendered pages are static, so they must not bake in a value read at build time.
  const bootRead = import.meta.prerender
    ? Promise.resolve()
    : Promise.race([Promise.allSettled([loadEulerChains(), loadV3ChainCatalog()]), delay(BOOT_READ_WAIT_MS)])

  nitroApp.hooks.hook('render:html', async (html) => {
    await bootRead
    const chainConfig = readServerChainPolicy(peekEulerChains())
    html.head.push(`<script>window.__CHAIN_CONFIG__=${escapeScriptJson(JSON.stringify(chainConfig))}</script>`)
  })
})
