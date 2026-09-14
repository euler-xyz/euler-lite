import {
  normalizeEulerLabelsFileData,
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
  & { geoContext?: HostedGeoContext, source?: 'v3' | 'static', logoBaseUrl?: string }

export const PUBLIC_LABELS_FIXTURE_VERSION = 'v20260804151305236'

export interface V3LabelsBundle {
  source?: 'v3'
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

export type PublicLabelsBundle = V3LabelsBundle | StaticLabelsBundle

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
  if (bundle.source !== 'static') return normalizePublicLabelsData(chainId, bundle.publicLabels)
  const data = normalizeEulerLabelsFileData(structuredClone(bundle.files))
  // Static authoring uses filenames; resolve them only against the operator's source.
  const logo = (value: string | undefined) => resolveLabelLogo(value, bundle.logoBaseUrl)
  for (const entity of Object.values(data.entities)) entity.logo = logo(entity.logo)
  for (const product of Object.values(data.products)) if (product.logo) product.logo = logo(product.logo)
  for (const points of Object.values(data.points)) for (const point of points) point.logo = logo(point.logo)
  return { ...data, source: 'static', logoBaseUrl: bundle.logoBaseUrl, rawGeoPolicies: [] }
}
