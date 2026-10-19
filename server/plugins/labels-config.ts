import { loadEulerChains } from '~/server/api/internal/euler-chains.get'
import { readLabelsSource, validateLabelsConfiguration } from '~/server/utils/labels-base-url'
import { LabelsConfigurationError } from '~/server/utils/labels-configuration-error'
import { logger } from '~/server/utils/logger'
import { readChainRegistry } from '~/utils/chain-status'

export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  const report = (error: unknown) => {
    if (error instanceof LabelsConfigurationError) {
      logger.error({ ctx: 'labels-config', message: error.message }, 'Invalid labels configuration; see docs/fork-setup.md')
    }
  }
  try {
    validateLabelsConfiguration()
    if (readLabelsSource() === 'v3') {
      void loadEulerChains().then(manifest => validateLabelsConfiguration(readChainRegistry(manifest))).catch(report)
    }
  }
  catch (error) { report(error) }
})
