import { parseChainIds } from '../../utils/parseChainIds'
import { loadEulerChains, peekEulerChains } from '../api/internal/euler-chains.get'
import { getChainEnvIssues, getConfiguredChainIds, getEnabledChainIds } from '~/utils/chain-env'
import { applyChainRegistry, readChainRegistry } from '~/utils/chain-status'
import { getUnknownChainIds } from '~/entities/chainRegistry'
import { escapeScriptJson } from '~/server/utils/escape-script-json'
import { logger } from '~/server/utils/logger'
import { parseEVaultFetchChunkChainIds } from '~/utils/eVaultFetchChunkConfig'

const BOOT_READ_WAIT_MS = 1_000

const delay = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

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

  const envChainConfig = {
    enabledChainIds,
    deprecatedChainIds,
    onchainSdkChainIds,
    eVaultFetchChunkChainIds,
    unsupportedChainIds: unknownChainIds,
    chainEnvIssues,
  }
  const isProduction = process.env.DOPPLER_ENVIRONMENT === 'prd'
  // Prerendered pages are static, so they must not bake in a value read at build time.
  const bootRead = import.meta.prerender
    ? Promise.resolve()
    : Promise.race([loadEulerChains().catch(() => undefined), delay(BOOT_READ_WAIT_MS)])

  nitroApp.hooks.hook('render:html', async (html) => {
    await bootRead
    const chainConfig = applyChainRegistry(envChainConfig, readChainRegistry(peekEulerChains()), isProduction)
    html.head.push(`<script>window.__CHAIN_CONFIG__=${escapeScriptJson(JSON.stringify(chainConfig))}</script>`)
  })
})
