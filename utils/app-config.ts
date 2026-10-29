import {
  DEFAULT_VAULT_DATA_SOURCE,
  readBrowserVaultSource,
  readDisableV3,
  isV3BackendEnabled,
  V3_API_PROXY_URL,
  type VaultDataSource,
} from '~/utils/api-url-env'
import {
  buildAnnouncementConfig,
  EMPTY_ANNOUNCEMENT_CONFIG,
  type AnnouncementConfig,
} from '~/utils/announcement-config'
import { edgeProvidesVpnEvidence, parseEdgeProvider } from '~/utils/edge-presets'

export interface AppEnvConfig {
  appTitle: string
  appDescription: string
  logoUrl: string
  socialImageUrl: string
  pythHermesUrl: string
  appKitProjectId: string
  appUrl: string
  v3ApiUrl: string
  /** Public V3 images base (ends in /v3/images) the server read from its V3;
   *  empty when unknown, so chain logos use bundled files and oracle-provider
   *  logos are hidden. */
  v3ImagesUrl: string
  /** True when the deployment has an upstream V3 API configured. Drives the
   *  SDK "fast" instance: when true it uses v3 adapters; when false it falls
   *  back to direct on-chain reads with longer caching. */
  enableV3Backend: boolean
  /** Explicit deployment-wide V3 opt-out, including optional utilities. */
  disableV3: boolean
  /** Adapter chain the browser's "fast" SDK uses (vault lists, prices,
   *  rewards). Mirrors `SERVER_VAULT_CACHE_SOURCE` on the snapshot side. */
  browserVaultSource: VaultDataSource
  swapApiUrl: string
  eulerInterfacesBranch: string
  announcement: AnnouncementConfig
  /** Whether the deployment's edge provider measures VPN usage. Drives the
   *  client VPN probe in services/vpn.ts — false skips it entirely. */
  vpnDetection: boolean
}

export const ENV_CONFIG_DEFAULTS: AppEnvConfig = {
  appTitle: 'Euler Lite',
  appDescription: 'Lightweight interface for Euler Finance lending and borrowing.',
  logoUrl: '',
  socialImageUrl: '',
  pythHermesUrl: '',
  appKitProjectId: '',
  appUrl: '',
  v3ApiUrl: '',
  v3ImagesUrl: '',
  enableV3Backend: false,
  disableV3: false,
  browserVaultSource: DEFAULT_VAULT_DATA_SOURCE,
  swapApiUrl: '',
  eulerInterfacesBranch: 'master',
  announcement: EMPTY_ANNOUNCEMENT_CONFIG,
  vpnDetection: false,
}

function envValue(source: NodeJS.ProcessEnv, key: string, ...fallbackKeys: string[]): string {
  for (const k of [key, ...fallbackKeys]) {
    if (source[k]) return source[k]!
  }
  return ''
}

export function readAppEnvConfig(source: NodeJS.ProcessEnv = process.env): AppEnvConfig {
  return {
    appTitle: envValue(source, 'APP_TITLE', 'NUXT_PUBLIC_CONFIG_APP_TITLE') || ENV_CONFIG_DEFAULTS.appTitle,
    appDescription: envValue(source, 'APP_DESCRIPTION', 'NUXT_PUBLIC_CONFIG_APP_DESCRIPTION') || ENV_CONFIG_DEFAULTS.appDescription,
    logoUrl: envValue(source, 'LOGO_URL', 'NUXT_PUBLIC_CONFIG_LOGO_URL') || ENV_CONFIG_DEFAULTS.logoUrl,
    socialImageUrl: envValue(source, 'SOCIAL_IMAGE_URL', 'NUXT_PUBLIC_CONFIG_SOCIAL_IMAGE_URL') || ENV_CONFIG_DEFAULTS.socialImageUrl,
    pythHermesUrl: envValue(source, 'PYTH_API_KEY').trim() ? 'proxy' : '',
    appKitProjectId: envValue(source, 'APPKIT_PROJECT_ID', 'NUXT_PUBLIC_APP_KIT_PROJECT_ID') || ENV_CONFIG_DEFAULTS.appKitProjectId,
    appUrl: envValue(source, 'NUXT_PUBLIC_APP_URL') || ENV_CONFIG_DEFAULTS.appUrl,
    v3ApiUrl: V3_API_PROXY_URL,
    v3ImagesUrl: ENV_CONFIG_DEFAULTS.v3ImagesUrl,
    enableV3Backend: isV3BackendEnabled(source),
    disableV3: readDisableV3(source),
    browserVaultSource: readBrowserVaultSource(source),
    swapApiUrl: envValue(source, 'SWAP_API_URL', 'NUXT_PUBLIC_SWAP_API_URL') || ENV_CONFIG_DEFAULTS.swapApiUrl,
    eulerInterfacesBranch: envValue(source,
      'EULER_SDK_EULER_INTERFACES_BRANCH',
      'NUXT_PUBLIC_EULER_INTERFACES_BRANCH',
      'NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH',
    ) || ENV_CONFIG_DEFAULTS.eulerInterfacesBranch,
    announcement: buildAnnouncementConfig({
      title: envValue(source, 'CONFIG_ANNOUNCEMENT_TITLE', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_TITLE'),
      body: envValue(source, 'CONFIG_ANNOUNCEMENT_BODY', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_BODY'),
      items: envValue(source, 'CONFIG_ANNOUNCEMENT_ITEMS', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_ITEMS'),
      url: envValue(source, 'CONFIG_ANNOUNCEMENT_URL', 'NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_URL'),
    }),
    vpnDetection: edgeProvidesVpnEvidence(parseEdgeProvider(source.EDGE_PROVIDER)),
  }
}
