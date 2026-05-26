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
import {
  readBrowserVaultSource,
  readV3ApiUrl,
  V3_API_PROXY_URL,
} from '~/utils/api-url-env'

const DEFAULTS = {
  appTitle: 'Euler Lite',
  appDescription: 'Lightweight interface for Euler Finance lending and borrowing.',
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function env(key: string, ...fallbackKeys: string[]): string {
  for (const k of [key, ...fallbackKeys]) {
    if (process.env[k]) return process.env[k]!
  }
  return ''
}

function readAppConfig() {
  return {
    appTitle: env('APP_TITLE', 'NUXT_PUBLIC_CONFIG_APP_TITLE') || DEFAULTS.appTitle,
    appDescription: env('APP_DESCRIPTION', 'NUXT_PUBLIC_CONFIG_APP_DESCRIPTION') || DEFAULTS.appDescription,
    logoUrl: env('LOGO_URL', 'NUXT_PUBLIC_CONFIG_LOGO_URL'),
    socialImageUrl: env('SOCIAL_IMAGE_URL', 'NUXT_PUBLIC_CONFIG_SOCIAL_IMAGE_URL'),
    pythHermesUrl: env('PYTH_HERMES_URL', 'NUXT_PUBLIC_PYTH_HERMES_URL') ? 'proxy' : '',
    appKitProjectId: env('APPKIT_PROJECT_ID', 'NUXT_PUBLIC_APP_KIT_PROJECT_ID'),
    appUrl: env('NUXT_PUBLIC_APP_URL'),
    v3ApiUrl: V3_API_PROXY_URL,
    // The client uses this to decide whether the SDK's "fast" instance routes
    // reads via /api/v3 (v3 adapters) or falls back to direct on-chain reads.
    enableV3Backend: !!readV3ApiUrl(),
    // Adapter chain pinned for the browser's "fast" SDK instance. See
    // utils/api-url-env.ts:readBrowserVaultSource.
    browserVaultSource: readBrowserVaultSource(),
    swapApiUrl: env('SWAP_API_URL', 'NUXT_PUBLIC_SWAP_API_URL'),
  }
}

function patchMeta(html: { head: string[] }, appConfig: ReturnType<typeof readAppConfig>) {
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
  const appConfig = readAppConfig()
  const scriptTag = `<script>window.__APP_CONFIG__=${JSON.stringify(appConfig)}</script>`

  nitroApp.hooks.hook('render:html', (html) => {
    html.head.push(scriptTag)
    patchMeta(html, appConfig)
    injectSocialImage(html, appConfig.socialImageUrl)
  })
})
