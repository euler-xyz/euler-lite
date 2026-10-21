import { resolveTenderlyConfigState } from '~/server/utils/tenderly'
import { logger } from '~/server/utils/logger'

export default defineNitroPlugin(() => {
  const state = resolveTenderlyConfigState()
  if (state.reason && (process.env.TENDERLY_ACCESS_KEY || process.env.TENDERLY_ACCOUNT_SLUG || process.env.TENDERLY_PROJECT_SLUG)) {
    logger.warn({ ctx: 'tenderly-config', reason: state.reason }, 'Tenderly disabled by incomplete or invalid configuration')
  }
})
