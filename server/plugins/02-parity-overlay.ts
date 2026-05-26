import { readFileSync } from 'node:fs'
import { logger } from '~/server/utils/logger'

function loadParityOverlayScript(): string {
  if (process.env.PARITY_OVERLAY_INJECT !== '1') return ''

  const scriptPath = process.env.PARITY_OVERLAY_SCRIPT_PATH
  if (!scriptPath) return ''

  try {
    return readFileSync(scriptPath, 'utf8').replace(/<\/script/gi, '<\\/script')
  }
  catch (error) {
    logger.warn(
      { ctx: 'parity-overlay', error },
      'failed to load parity overlay injection script',
    )
    return ''
  }
}

export default defineNitroPlugin((nitroApp) => {
  const script = loadParityOverlayScript()
  if (!script) return

  const scriptTag = `<script data-parity-overlay>${script}</script>`

  nitroApp.hooks.hook('render:html', (html) => {
    html.bodyAppend.push(scriptTag)
  })
})
