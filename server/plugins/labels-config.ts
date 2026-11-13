import { validateLabelsConfiguration } from '~/server/utils/labels-base-url'
import { LabelsConfigurationError } from '~/server/utils/labels-configuration-error'
import { logger } from '~/server/utils/logger'

export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  try {
    validateLabelsConfiguration()
  }
  catch (error) {
    if (error instanceof LabelsConfigurationError) {
      logger.error({ ctx: 'labels-config', message: error.message }, 'Invalid labels configuration; see docs/fork-setup.md')
    }
  }
})
