/**
 * Boot-time edge configuration guard.
 *
 * Refuses to start when EDGE_PROVIDER is invalid, or unset in production —
 * a production deployment that silently fell back to the `none` preset
 * would serve sanctioned countries (geo-blocking off) and lose its trusted
 * client identity. Failing the boot turns that misconfiguration into a
 * deploy-time incident instead of a compliance one.
 */
import { assertEdgeConfig } from '~/server/utils/edge'
import { parseEdgeProvider } from '~/utils/edge-presets'
import { logger } from '~/server/utils/logger'

export default defineNitroPlugin(() => {
  assertEdgeConfig()
  logger.info(
    {
      ctx: 'edge-guard',
      edgeProvider: parseEdgeProvider(process.env.EDGE_PROVIDER),
      originAuth: process.env.EDGE_ORIGIN_SECRET?.trim() ? 'enforced' : 'off',
    },
    'edge provider configuration resolved',
  )
})
