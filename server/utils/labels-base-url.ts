import { getEnabledChainIds } from '~/utils/chain-env'
import { parseChainIds } from '~/utils/parseChainIds'

export const readLabelsSource = (): 'v3' | 'static' => {
  const source = process.env.LABELS_SOURCE?.trim() || 'v3'
  if (source !== 'v3' && source !== 'static') throw new Error('LABELS_SOURCE must be v3 or static')
  return source
}

export function resolveLabelsBaseUrl(): string {
  const value = process.env.STATIC_LABELS_BASE_URL?.trim().replace(/\/+$/, '')
  if (!value) throw new Error('STATIC_LABELS_BASE_URL is required for static labels')
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('STATIC_LABELS_BASE_URL must be an HTTP(S) directory URL without credentials, query or fragment')
  }
  return value
}

export const isV3LabelsVersionSelector = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !['draft', 'current', 'production'].includes(value)

export const readV3LabelsSelection = () => {
  const labelSet = process.env.LABELS_V3_SET?.trim() || 'public'
  const version = process.env.LABELS_V3_VERSION?.trim() || 'latest'
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(labelSet)) throw new Error('LABELS_V3_SET must be a label set ID (letters, numbers, underscore or hyphen; max 100 characters)')
  if (!isV3LabelsVersionSelector(version)) throw new Error('LABELS_V3_VERSION must be latest or a published version key (max 100 letters, numbers, dots, underscores or hyphens)')
  return { labelSet, version }
}

/** Deprecated enabled chains retain metadata with on-chain verification. */
export const readLabelsOnchainVerificationChains = (): number[] => {
  const enabled = new Set(getEnabledChainIds())
  const deprecated = [...new Set(parseChainIds(process.env.DEPRECATED_CHAINS, enabled))]
  const onchain = new Set(parseChainIds(process.env.ONCHAIN_SDK_CHAINS))
  const missing = deprecated.filter(id => !onchain.has(id))
  if (missing.length) {
    throw new Error(`Deprecated labels chains must be in ONCHAIN_SDK_CHAINS: ${missing.join(',')}`)
  }
  return deprecated
}
