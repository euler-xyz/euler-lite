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
  const edgeProvider = parseEdgeProvider(process.env.EDGE_PROVIDER)
  const originAuth = process.env.EDGE_ORIGIN_SECRET?.trim() ? 'enforced' : 'off'
  logger.info({ ctx: 'edge-guard', edgeProvider, originAuth }, 'edge provider configuration resolved')

  // `none` is a permitted, explicit opt-out in production, but it carries no
  // trusted identity: geo-blocking is off and the rate limiter keys on a
  // forgeable x-forwarded-for entry (see server/utils/rate-limit.ts).
  if (edgeProvider === 'none' && process.env.DOPPLER_ENVIRONMENT === 'prd') {
    logger.warn(
      { ctx: 'edge-guard', edgeProvider },
      'production is running without a fronting edge: geo-blocking disabled, rate-limit identity forgeable',
    )
  }
})
