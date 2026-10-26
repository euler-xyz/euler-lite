import { getEnabledChainIds } from '~/utils/chain-env'
import { parseChainIds } from '~/utils/parseChainIds'
import type { ChainRegistry } from '~/utils/chain-status'
import { applyChainRegistry } from '~/utils/chain-status'
import { DEFAULT_V3_API_URL, readDisableV3, readResolvedV3ApiUrl, readBrowserVaultSource, readServerVaultCacheSource } from '~/utils/api-url-env'
import { LabelsConfigurationError } from './labels-configuration-error'

export const readLabelsVaultTag = (): string | undefined =>
  process.env.LABELS_VAULT_TAG?.trim() || undefined

export const readLabelsSource = (): 'v3' | 'static' => {
  const source = process.env.LABELS_SOURCE?.trim() || 'v3'
  if (source !== 'v3' && source !== 'static') throw new LabelsConfigurationError('LABELS_SOURCE must be v3 or static')
  return source
}

export function resolveLabelsBaseUrl(): string {
  const value = process.env.STATIC_LABELS_BASE_URL?.trim().replace(/\/+$/, '')
  if (!value) throw new LabelsConfigurationError('STATIC_LABELS_BASE_URL is required for static labels')
  readHttpDirectory(value, 'STATIC_LABELS_BASE_URL')
  return value
}

export const isV3LabelsVersionSelector = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !['draft', 'current', 'production'].includes(value)

export const readV3LabelsSelection = () => {
  if (readDisableV3()) throw new LabelsConfigurationError('DISABLE_V3 requires LABELS_SOURCE=static and STATIC_LABELS_BASE_URL, or enable V3 to use hosted labels')
  readHttpDirectory(readResolvedV3ApiUrl(), 'V3_API_URL')
  const labelSet = process.env.LABELS_V3_SET?.trim() || 'public'
  const version = process.env.LABELS_V3_VERSION?.trim() || 'latest'
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(labelSet)) throw new LabelsConfigurationError('LABELS_V3_SET must be a label set ID (letters, numbers, underscore or hyphen; max 100 characters)')
  if (!isV3LabelsVersionSelector(version)) throw new LabelsConfigurationError('LABELS_V3_VERSION must be latest or a published version key (max 100 letters, numbers, dots, underscores or hyphens)')
  return { labelSet, version }
}

/** Deprecated enabled chains retain metadata with on-chain verification. */
export const isLabelsOnchainVerificationChain = (chainId: number, registry: ChainRegistry): boolean => {
  const enabled = new Set(getEnabledChainIds())
  if (!enabled.has(chainId)) return false
  const deprecated = registry.statuses[chainId] === 'deprecated'
    || parseChainIds(process.env.DEPRECATED_CHAINS, enabled).includes(chainId)
  if (!deprecated) return false
  const onchain = new Set(parseChainIds(process.env.ONCHAIN_SDK_CHAINS))
  if (!onchain.has(chainId)) {
    throw new LabelsConfigurationError(`Deprecated labels chains must be in ONCHAIN_SDK_CHAINS: ${chainId}. Add the chain ID and restart the service.`)
  }
  return true
}

function readHttpDirectory(value: string, setting: string): URL {
  try {
    const url = new URL(value)
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url
  }
  catch { /* Return an operator-safe error without echoing the URL. */ }
  throw new LabelsConfigurationError(`${setting} must be an HTTP(S) directory URL without credentials, query or fragment`)
}

/** Server-only trust configuration; never derived from a logo's own URL. */
export function readHostedLabelImageOrigins(): string[] {
  const origins = (process.env.LABELS_IMAGE_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map((value) => {
    const url = readHttpDirectory(value, 'LABELS_IMAGE_ORIGINS')
    if (url.pathname !== '/') throw new LabelsConfigurationError('LABELS_IMAGE_ORIGINS must contain comma-separated HTTP(S) origins without paths')
    return url.origin
  })
  if (!readDisableV3()) {
    const upstream = readHttpDirectory(readResolvedV3ApiUrl(), 'V3_API_URL')
    // Keep the existing Euler-host path restrictions unless explicitly opted out.
    if (upstream.origin !== new URL(DEFAULT_V3_API_URL).origin) origins.push(upstream.origin)
  }
  return [...new Set(origins)]
}

export function validateLabelsConfiguration(registry?: ChainRegistry): void {
  const source = readLabelsSource()
  readHostedLabelImageOrigins()
  if (readDisableV3() && (readBrowserVaultSource() === 'v3' || readServerVaultCacheSource() === 'v3')) {
    throw new LabelsConfigurationError('DISABLE_V3 requires SERVER_VAULT_CACHE_SOURCE and NUXT_PUBLIC_BROWSER_VAULT_SOURCE to be fallback or onchain')
  }
  if (source === 'static') {
    resolveLabelsBaseUrl()
    return
  }
  readV3LabelsSelection()
  // Wait for admission before diagnosing chains: an incomplete launch or a
  // hidden registry row must not turn healthy deployments into config errors.
  if (!registry) return
  const { enabledChainIds } = applyChainRegistry({
    enabledChainIds: getEnabledChainIds(),
    deprecatedChainIds: [],
    onchainSdkChainIds: [],
    eVaultFetchChunkChainIds: [],
  }, registry, process.env.DOPPLER_ENVIRONMENT === 'prd')
  for (const chainId of enabledChainIds) isLabelsOnchainVerificationChain(chainId, registry)
}
