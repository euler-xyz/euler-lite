/**
 * Nitro plugin that reads app-level env vars at server startup
 * and injects them into the HTML via render:html hook.
 *
 * This runs at server startup, so Doppler-injected env vars are available.
 * The config is embedded as a <script> tag in the HTML head, making it
 * accessible to the client synchronously via window.__APP_CONFIG__.
 *
 * Also patches <title> and meta tags so crawlers see the correct values.
 */
import { readAppEnvConfig } from '~/utils/app-config'
import { escapeScriptJson } from '~/server/utils/escape-script-json'
import { createV3ImagesBaseSource } from '~/server/utils/v3-images-base'

export { escapeScriptJson }

const BOOT_READ_WAIT_MS = 1_000

const delay = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function patchMeta(html: { head: string[] }, appConfig: ReturnType<typeof readAppEnvConfig>) {
  const appTitle = escapeHtml(appConfig.appTitle)
  const appDescription = escapeHtml(appConfig.appDescription)

  html.head = html.head.map((chunk) => {
    let patched = chunk

    // Replace <title>…</title>
    patched = patched.replace(/<title>[^<]*<\/title>/, `<title>${appTitle}</title>`)

    // Replace content="…" on relevant meta tags
    patched = patched.replace(
      /(<meta\s+property="og:title"\s+content=")[^"]*(")/,
      `$1${appTitle}$2`,
    )
    patched = patched.replace(
      /(<meta\s+name="twitter:title"\s+content=")[^"]*(")/,
      `$1${appTitle}$2`,
    )
    patched = patched.replace(
      /(<meta\s+name="description"\s+content=")[^"]*(")/,
      `$1${appDescription}$2`,
    )
    patched = patched.replace(
      /(<meta\s+property="og:description"\s+content=")[^"]*(")/,
      `$1${appDescription}$2`,
    )
    patched = patched.replace(
      /(<meta\s+name="twitter:description"\s+content=")[^"]*(")/,
      `$1${appDescription}$2`,
    )

    return patched
  })
}

function injectSocialImage(html: { head: string[] }, socialImageUrl: string) {
  // Only injected when env var is set so forks without one don't ship
  // broken/empty preview tags. Crawlers (X, Slack, Discord) fetch the image
  // directly from this absolute URL; the SPA useHead mirrors this for runtime.
  // Require https:// so a misconfigured env var can't emit http://, data:, or
  // javascript: URIs — X and Slack reject non-https og:image anyway.
  if (!socialImageUrl.startsWith('https://')) return
  const url = escapeHtml(socialImageUrl)
  html.head.push(
    `<meta property="og:image" content="${url}">`
    + `<meta name="twitter:image" content="${url}">`,
  )
}

export default defineNitroPlugin((nitroApp) => {
  const appConfig = readAppEnvConfig()
  const v3ImagesBase = createV3ImagesBaseSource()
  // Prerendered pages are static, so they must not bake in a value read at build time.
  const bootRead = import.meta.prerender || appConfig.disableV3
    ? Promise.resolve()
    : Promise.race([v3ImagesBase.start(), delay(BOOT_READ_WAIT_MS)])
  nitroApp.hooks.hook('close', () => v3ImagesBase.stop())

  nitroApp.hooks.hook('render:html', async (html) => {
    await bootRead
    const config = { ...appConfig, v3ImagesUrl: v3ImagesBase.get() }
    html.head.push(`<script>window.__APP_CONFIG__=${escapeScriptJson(JSON.stringify(config))}</script>`)
    patchMeta(html, appConfig)
    injectSocialImage(html, appConfig.socialImageUrl)
  })
})
