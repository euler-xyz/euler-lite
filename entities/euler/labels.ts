import type {
  EulerLabelAssetEntry as SdkEulerLabelAssetEntry,
  EulerLabelEarnVaultEntry as SdkEulerLabelEarnVaultEntry,
  EulerLabelEntity as SdkEulerLabelEntity,
  EulerLabelPoint as SdkEulerLabelPoint,
  EulerLabelProduct as SdkEulerLabelProduct,
  EulerLabelVaultOverride as SdkEulerLabelVaultOverride,
} from '@eulerxyz/euler-v2-sdk/public-labels'

export type EulerLabelEntity = SdkEulerLabelEntity
export type EulerLabelVaultOverride = SdkEulerLabelVaultOverride
export type EulerLabelEarnVaultEntry = SdkEulerLabelEarnVaultEntry
export type EulerLabelAssetEntry = SdkEulerLabelAssetEntry
export type EulerLabelPoint = SdkEulerLabelPoint
export type EulerLabelPointReward = SdkEulerLabelPoint

// Lite's existing UI assumes every rendered product has a managing entity.
// Public Labels normalization guarantees that shape for product records.
export type EulerLabelProduct = Omit<SdkEulerLabelProduct, 'entity'> & {
  entity: string[] | string
}

export const eulerLabelEntityEmpty = {
  name: '',
  logo: '',
  description: '',
  url: '',
  addresses: {},
  social: {
    twitter: '',
    youtube: '',
    discord: '',
    telegram: '',
    github: '',
  },
} as EulerLabelEntity

export const eulerLabelProductEmpty = {
  name: '',
  description: '',
  entity: [],
  url: '',
  vaults: [],
  deprecatedVaults: [],
  deprecationReason: '',
  vaultOverrides: {},
} as EulerLabelProduct

export const getEulerLabelEntityLogo = (fileName: string) =>
  /^https?:\/\//i.test(fileName) ? fileName : ''

export const getEulerLabelPointLogo = (fileName: string) =>
  /^https?:\/\//i.test(fileName) ? fileName : ''

export const getEntityLogoLocalPath = (fileName: string) => `/entities/${fileName}`
