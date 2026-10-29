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

import { DEFAULT_VAULT_DATA_SOURCE, V3_API_PROXY_URL, type VaultDataSource } from '~/utils/api-url-env'
import { buildAnnouncementConfig } from '~/utils/announcement-config'
import { ENV_CONFIG_DEFAULTS as DEFAULTS, readAppEnvConfig, type AppEnvConfig as EnvConfig } from '~/utils/app-config'

export type { AppEnvConfig as EnvConfig } from '~/utils/app-config'

declare global {
  interface Window {
    /** Server-injected runtime config (server/plugins/app-config.ts). */
    __APP_CONFIG__?: EnvConfig
  }
}

let cached: EnvConfig | null = null

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
    v3ImagesUrl: DEFAULTS.v3ImagesUrl,
    enableV3Backend: !isTruthy(rc.disableV3) && isTruthy(rc.enableV3Backend),
    disableV3: isTruthy(rc.disableV3),
    browserVaultSource: parseSource(rc.browserVaultSource),
    swapApiUrl: str(rc.swapApiUrl) || DEFAULTS.swapApiUrl,
    eulerInterfacesBranch: str(rc.eulerInterfacesBranch) || DEFAULTS.eulerInterfacesBranch,
    announcement: buildAnnouncementConfig({
      title: rc.configAnnouncementTitle,
      body: rc.configAnnouncementBody,
      items: rc.configAnnouncementItems,
      url: rc.configAnnouncementUrl,
    }),
    // Static/CDN deployments carry no edge preset information — skip the
    // VPN probe (the server derives the authoritative verdict from edge
    // request headers regardless).
    vpnDetection: false,
  }
}

export const useEnvConfig = (): EnvConfig => {
  if (cached) return cached

  if (import.meta.server) {
    cached = readAppEnvConfig()
  }
  else if (typeof window !== 'undefined' && window.__APP_CONFIG__) {
    cached = window.__APP_CONFIG__
  }
  else {
    cached = fromRuntimeConfig()
  }

  return cached!
}
