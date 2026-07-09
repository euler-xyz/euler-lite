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

import {
  DEFAULT_VAULT_DATA_SOURCE,
  readBrowserVaultSource,
  readV3ApiUrl,
  V3_API_PROXY_URL,
  type VaultDataSource,
} from '~/utils/api-url-env'
import {
  buildAnnouncementConfig,
  EMPTY_ANNOUNCEMENT_CONFIG,
  type AnnouncementConfig,
} from '~/utils/announcement-config'

interface EnvConfig {
  appTitle: string
  appDescription: string
  logoUrl: string
  socialImageUrl: string
  pythHermesUrl: string
  appKitProjectId: string
  appUrl: string
  v3ApiUrl: string
  /** True when the deployment has an upstream V3 API configured. Drives the
   *  SDK "fast" instance: when true it uses v3 adapters; when false it falls
   *  back to direct on-chain reads with longer caching. */
  enableV3Backend: boolean
  /** Adapter chain the browser's "fast" SDK uses (vault lists, prices,
   *  rewards). Mirrors `SERVER_VAULT_CACHE_SOURCE` on the snapshot side. */
  browserVaultSource: VaultDataSource
  swapApiUrl: string
  announcement: AnnouncementConfig
}

const DEFAULTS: EnvConfig = {
  appTitle: 'Euler Lite',
  appDescription: 'Lightweight interface for Euler Finance lending and borrowing.',
  logoUrl: '',
  socialImageUrl: '',
  pythHermesUrl: '',
  appKitProjectId: '',
  appUrl: '',
  v3ApiUrl: '',
  enableV3Backend: false,
  browserVaultSource: DEFAULT_VAULT_DATA_SOURCE,
  swapApiUrl: '',
  announcement: EMPTY_ANNOUNCEMENT_CONFIG,
}

let cached: EnvConfig | null = null

function env(key: string, ...fallbackKeys: string[]): string {
  for (const k of [key, ...fallbackKeys]) {
    if (process.env[k]) return process.env[k]!
  }
  return ''
}

function scanEnv(): EnvConfig {
  const v3UpstreamConfigured = !!readV3ApiUrl()
  return {
    appTitle: env('APP_TITLE', 'NUXT_PUBLIC_CONFIG_APP_TITLE') || DEFAULTS.appTitle,
    appDescription: env('APP_DESCRIPTION', 'NUXT_PUBLIC_CONFIG_APP_DESCRIPTION') || DEFAULTS.appDescription,
    logoUrl: env('LOGO_URL', 'NUXT_PUBLIC_CONFIG_LOGO_URL') || DEFAULTS.logoUrl,
    socialImageUrl: env('SOCIAL_IMAGE_URL', 'NUXT_PUBLIC_CONFIG_SOCIAL_IMAGE_URL') || DEFAULTS.socialImageUrl,
    pythHermesUrl: env('PYTH_HERMES_URL', 'NUXT_PUBLIC_PYTH_HERMES_URL') || '',
    appKitProjectId: env('APPKIT_PROJECT_ID', 'NUXT_PUBLIC_APP_KIT_PROJECT_ID') || DEFAULTS.appKitProjectId,
    appUrl: env('NUXT_PUBLIC_APP_URL') || DEFAULTS.appUrl,
    v3ApiUrl: V3_API_PROXY_URL,
    enableV3Backend: v3UpstreamConfigured,
    browserVaultSource: readBrowserVaultSource(),
    swapApiUrl: env('SWAP_API_URL', 'NUXT_PUBLIC_SWAP_API_URL') || DEFAULTS.swapApiUrl,
    announcement: buildAnnouncementConfig({
      title: env('CONFIG_ANNOUNCEMENT_TITLE', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_TITLE'),
      body: env('CONFIG_ANNOUNCEMENT_BODY', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_BODY'),
      items: env('CONFIG_ANNOUNCEMENT_ITEMS', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_ITEMS'),
      url: env('CONFIG_ANNOUNCEMENT_URL', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_URL'),
    }),
  }
}

function fromRuntimeConfig(): EnvConfig {
  const rc = useRuntimeConfig().public
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const isTruthy = (v: unknown): boolean => {
    const s = str(v).toLowerCase().trim()
    return s === '1' || s === 'true' || s === 'yes'
  }
  const parseSource = (v: unknown): VaultDataSource => {
    const s = str(v).toLowerCase().trim()
    return (s === 'fallback' || s === 'onchain' || s === 'v3')
      ? s as VaultDataSource
      : DEFAULT_VAULT_DATA_SOURCE
  }

  return {
    appTitle: str(rc.configAppTitle) || DEFAULTS.appTitle,
    appDescription: str(rc.configAppDescription) || DEFAULTS.appDescription,
    logoUrl: str(rc.configLogoUrl) || DEFAULTS.logoUrl,
    socialImageUrl: str(rc.configSocialImageUrl) || DEFAULTS.socialImageUrl,
    pythHermesUrl: str(rc.pythHermesUrl) ? 'proxy' : '',
    appKitProjectId: str(rc.appKitProjectId) || DEFAULTS.appKitProjectId,
    appUrl: str(rc.appUrl) || DEFAULTS.appUrl,
    v3ApiUrl: str(rc.v3ApiUrl) || V3_API_PROXY_URL,
    enableV3Backend: isTruthy(rc.enableV3Backend),
    browserVaultSource: parseSource(rc.browserVaultSource),
    swapApiUrl: str(rc.swapApiUrl) || DEFAULTS.swapApiUrl,
    announcement: buildAnnouncementConfig({
      title: rc.configAnnouncementTitle,
      body: rc.configAnnouncementBody,
      items: rc.configAnnouncementItems,
      url: rc.configAnnouncementUrl,
    }),
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
