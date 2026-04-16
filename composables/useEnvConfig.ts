/**
 * Provides app-level configuration derived from environment variables.
 *
 * Resolution order (first non-empty wins):
 *   1. window.__APP_CONFIG__  – injected at runtime by server/plugins/app-config.ts
 *   2. useRuntimeConfig().public – build-time values from NUXT_PUBLIC_* env vars
 *   3. Hard-coded DEFAULTS
 *
 * (1) supports Doppler-injected env vars that change without a rebuild.
 * (2) covers static / CDN deployments where the Nitro render hook never fires.
 */

interface EnvConfig {
  appTitle: string
  appDescription: string
  logoUrl: string
  socialImageUrl: string
  pythHermesUrl: string
  appKitProjectId: string
  appUrl: string
  eulerApiUrl: string
  swapApiUrl: string
  priceApiUrl: string
}

const DEFAULTS: EnvConfig = {
  appTitle: 'Euler Lite',
  appDescription: 'Lightweight interface for Euler Finance lending and borrowing.',
  logoUrl: '',
  socialImageUrl: '',
  pythHermesUrl: '',
  appKitProjectId: '',
  appUrl: '',
  eulerApiUrl: '',
  swapApiUrl: '',
  priceApiUrl: '',
}

let cached: EnvConfig | null = null

function env(key: string, ...fallbackKeys: string[]): string {
  for (const k of [key, ...fallbackKeys]) {
    if (process.env[k]) return process.env[k]!
  }
  return ''
}

function scanEnv(): EnvConfig {
  return {
    appTitle: env('APP_TITLE', 'NUXT_PUBLIC_CONFIG_APP_TITLE') || DEFAULTS.appTitle,
    appDescription: env('APP_DESCRIPTION', 'NUXT_PUBLIC_CONFIG_APP_DESCRIPTION') || DEFAULTS.appDescription,
    logoUrl: env('LOGO_URL', 'NUXT_PUBLIC_CONFIG_LOGO_URL') || DEFAULTS.logoUrl,
    socialImageUrl: env('SOCIAL_IMAGE_URL', 'NUXT_PUBLIC_CONFIG_SOCIAL_IMAGE_URL') || DEFAULTS.socialImageUrl,
    pythHermesUrl: env('PYTH_HERMES_URL', 'NUXT_PUBLIC_PYTH_HERMES_URL') || '',
    appKitProjectId: env('APPKIT_PROJECT_ID', 'NUXT_PUBLIC_APP_KIT_PROJECT_ID') || DEFAULTS.appKitProjectId,
    appUrl: env('NUXT_PUBLIC_APP_URL') || DEFAULTS.appUrl,
    eulerApiUrl: env('EULER_API_URL', 'NUXT_PUBLIC_EULER_API_URL') || DEFAULTS.eulerApiUrl,
    swapApiUrl: env('SWAP_API_URL', 'NUXT_PUBLIC_SWAP_API_URL') || DEFAULTS.swapApiUrl,
    priceApiUrl: env('PRICE_API_URL', 'NUXT_PUBLIC_PRICE_API_URL') || DEFAULTS.priceApiUrl,
  }
}

function fromRuntimeConfig(): EnvConfig {
  const rc = useRuntimeConfig().public
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  return {
    appTitle: str(rc.configAppTitle) || DEFAULTS.appTitle,
    appDescription: str(rc.configAppDescription) || DEFAULTS.appDescription,
    logoUrl: str(rc.configLogoUrl) || DEFAULTS.logoUrl,
    socialImageUrl: str(rc.configSocialImageUrl) || DEFAULTS.socialImageUrl,
    pythHermesUrl: str(rc.pythHermesUrl) ? 'proxy' : '',
    appKitProjectId: str(rc.appKitProjectId) || DEFAULTS.appKitProjectId,
    appUrl: str(rc.appUrl) || DEFAULTS.appUrl,
    eulerApiUrl: str(rc.eulerApiUrl) || DEFAULTS.eulerApiUrl,
    swapApiUrl: str(rc.swapApiUrl) || DEFAULTS.swapApiUrl,
    priceApiUrl: str(rc.priceApiUrl) || DEFAULTS.priceApiUrl,
  }
}

export const useEnvConfig = (): EnvConfig => {
  if (cached) return cached

  if (import.meta.server) {
    cached = scanEnv()
  }
  /* eslint-disable @typescript-eslint/no-explicit-any -- server-injected window global */
  else if (typeof window !== 'undefined' && (window as any).__APP_CONFIG__) {
    cached = (window as any).__APP_CONFIG__
  /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  else {
    cached = fromRuntimeConfig()
  }

  return cached!
}
