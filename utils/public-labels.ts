import { isEulerLabelVaultNotExplorableLend, isEulerLabelVaultNotExplorableBorrow, isEulerLabelEarnVaultNotExplorable } from '@eulerxyz/euler-v2-sdk'
import {
  normalizeEulerLabelsFileData,
  normalizePublicLabelsMetadata,
  type PublicLabelsMetadataSnapshot,
  type EulerLabelsFileData,
  normalizePublicLabelsData as normalizeSdkPublicLabelsData,
  type PublicEulerLabelsData as SdkPublicEulerLabelsData,
  type PublicLabelsSource,
} from '@eulerxyz/euler-v2-sdk/public-labels'
import type { HostedGeoContext } from '~/utils/geo-policies'
import { resolveLabelLogo } from '~/utils/label-logo'

export {
  PUBLIC_LABELS_RUNTIME_VERSION,
} from '@eulerxyz/euler-v2-sdk/public-labels'

export type {
  PublicEntityAddress,
  PublicEntityLabel,
  PublicGeoPolicy,
  PublicLabelsMeta,
  PublicLabelsQuery,
  PublicLabelsRequest,
  PublicLabelsResponse,
  PublicLabelsSource,
  PublicProductLabel,
  PublicVaultCampaign,
  PublicVaultLabel,
} from '@eulerxyz/euler-v2-sdk/public-labels'

export type PublicEulerLabelsData = Omit<SdkPublicEulerLabelsData, 'visibility' | 'managingEntityByVault'>
  & Partial<Pick<SdkPublicEulerLabelsData, 'visibility' | 'managingEntityByVault'>>
  & { geoContext?: HostedGeoContext, source?: 'v3' | 'v3-metadata' | 'static', logoBaseUrl?: string, candidateVaultAddresses?: string[], candidateEarnVaultAddresses?: string[], vaultTagAddresses?: Set<string> }

export const PUBLIC_LABELS_FIXTURE_VERSION = 'v20260804151305236'

export interface V3LabelsBundle {
  source?: 'v3'
  labelSet?: string
  version: string
  publicLabels: PublicLabelsSource
  geoFetchedAt?: number
}

export interface StaticLabelsBundle {
  source: 'static'
  version: string
  files: EulerLabelsFileData
  logoBaseUrl: string
  fetchedAt: number
}

export type V3MetadataLabelsBundle = PublicLabelsMetadataSnapshot & { geoFetchedAt?: number }
export type HostedLabelsBundle = V3LabelsBundle | V3MetadataLabelsBundle
export type PublicLabelsBundle = (HostedLabelsBundle | StaticLabelsBundle) & { vaultTag?: string }

/** V3 owns hosted membership, published content and per-side visibility. */
export const normalizePublicLabelsData = (chainId: number, source: PublicLabelsSource): PublicEulerLabelsData => {
  const data = normalizeSdkPublicLabelsData(chainId, source)
  for (const product of Object.values(data.products)) {
    for (const address of [...product.vaults, ...(product.deprecatedVaults ?? [])]) {
      const verdict = source.visibility[address.toLowerCase()]
      const override = product.vaultOverrides?.[address]
      if (!override) continue
      override.notExplorableLend = verdict?.explorableLend !== true
      override.notExplorableBorrow = verdict?.explorableBorrow !== true
    }
  }
  for (const [address, entry] of Object.entries(data.earnVaultEntries)) {
    entry.notExplorable = source.visibility[address]?.explorableLend !== true
    if (entry.notExplorable) data.notExplorableEarnVaults.add(address)
  }
  return {
    ...data,
    source: 'v3',
    geoContext: {
      chainId,
      policies: data.rawGeoPolicies,
      productByVault: Object.fromEntries(source.vaults.filter(vault => vault.chainId === chainId)
        .map(vault => [vault.address.toLowerCase(), vault.productId])),
    },
  }
}

const normalizeLabelsSource = (chainId: number, bundle: PublicLabelsBundle): PublicEulerLabelsData => {
  if (bundle.source === 'v3-metadata') {
    const data = normalizePublicLabelsMetadata(chainId, bundle.publicLabels)
    return { ...data, source: 'v3-metadata', geoContext: {
      chainId, policies: data.rawGeoPolicies,
      productByVault: Object.fromEntries(bundle.publicLabels.vaults
        .filter(vault => vault.chainId === chainId)
        .map(vault => [vault.address.toLowerCase(), vault.productId])),
    } }
  }
  if (bundle.source !== 'static') return normalizePublicLabelsData(chainId, bundle.publicLabels)
  const data = normalizeEulerLabelsFileData(structuredClone(bundle.files))
  // Static authoring uses filenames; resolve them only against the operator's source.
  const logo = (value: string | undefined) => resolveLabelLogo(value, bundle.logoBaseUrl)
  for (const entity of Object.values(data.entities)) entity.logo = logo(entity.logo)
  for (const product of Object.values(data.products)) if (product.logo) product.logo = logo(product.logo)
  for (const points of Object.values(data.points)) for (const point of points) point.logo = logo(point.logo)
  return { ...data, source: 'static', logoBaseUrl: bundle.logoBaseUrl, rawGeoPolicies: [] }
}

/** The optional deployment selection is independent of verification and listing flags. */
export const normalizeLabelsBundle = (chainId: number, bundle: PublicLabelsBundle): PublicEulerLabelsData => {
  const data = normalizeLabelsSource(chainId, bundle)
  const tag = bundle.vaultTag?.trim()
  if (!tag) return data

  const addresses = new Set<string>()
  if (bundle.source !== 'static') {
    // Raw rows retain tags for every vault type, including standalone escrow.
    for (const vault of bundle.publicLabels.vaults) {
      if (vault.chainId === chainId && vault.tags.includes(tag)) addresses.add(vault.address.toLowerCase())
    }
  }
  else {
    for (const product of Object.values(data.products)) {
      for (const address of [...product.vaults, ...(product.deprecatedVaults ?? [])]) {
        if (product.tags?.includes(tag) || product.vaultOverrides?.[address]?.tags?.includes(tag)) {
          addresses.add(address.toLowerCase())
        }
      }
    }
    for (const [address, entry] of Object.entries(data.earnVaultEntries)) {
      if (entry.tags?.includes(tag)) addresses.add(address.toLowerCase())
    }
  }
  return { ...data, vaultTagAddresses: addresses }
}

/** Undefined selects every vault; a configured tag with no matches selects none. */
export const matchesDeploymentVaultTag = (labels: Pick<PublicEulerLabelsData, 'vaultTagAddresses'>, address: string): boolean =>
  labels.vaultTagAddresses?.has(address.toLowerCase()) ?? true

/** Fetch candidates are not a governance verdict. */
export const getLabelVaultCandidates = (labels: Pick<PublicEulerLabelsData,
  'source' | 'candidateVaultAddresses' | 'candidateEarnVaultAddresses' | 'verifiedVaultAddresses' | 'earnVaults'>) => ({
  vaults: labels.source === 'v3-metadata' ? labels.candidateVaultAddresses ?? [] : labels.verifiedVaultAddresses,
  earn: labels.source === 'v3-metadata' ? labels.candidateEarnVaultAddresses ?? [] : labels.earnVaults,
})

/** Reload vault data only when labels change membership or discovery eligibility. */
export const getLabelsVaultLoadKey = (labels: PublicEulerLabelsData): string => {
  const candidates = getLabelVaultCandidates(labels)
  return JSON.stringify([
    labels.source,
    (candidates.vaults ?? []).map(address => [address.toLowerCase(),
      isEulerLabelVaultNotExplorableLend(labels, address),
      isEulerLabelVaultNotExplorableBorrow(labels, address)]).sort(),
    (candidates.earn ?? []).map(address => [address.toLowerCase(), isEulerLabelEarnVaultNotExplorable(labels, address)]).sort(),
  ])
}
