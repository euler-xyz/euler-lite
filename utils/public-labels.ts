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
  & { geoContext?: HostedGeoContext, source?: 'v3' | 'v3-metadata' | 'static', logoBaseUrl?: string, candidateVaultAddresses?: string[], candidateEarnVaultAddresses?: string[] }

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
export type PublicLabelsBundle = HostedLabelsBundle | StaticLabelsBundle

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

export const normalizeLabelsBundle = (chainId: number, bundle: PublicLabelsBundle): PublicEulerLabelsData => {
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
