export type EulerLabelEntity = {
  name: string
  logo: string
  description: string
  url: string
  addresses: Record<string, string>
  social: {
    twitter: string
    youtube: string
    discord: string
    telegram: string
    github: string
  }
}
export type EulerLabelVaultOverride = {
  name?: string
  description?: string
  portfolioNotice?: string
  deprecationReason?: string
  block?: string[]
  restricted?: string[]
  notExplorableLend?: boolean
  notExplorableBorrow?: boolean
  keyring?: boolean
}

export type EulerLabelProduct = {
  name: string
  description: string
  portfolioNotice?: string
  entity: string[] | string
  url: string
  vaults: string[]
  deprecatedVaults?: string[]
  deprecationReason?: string
  isGovernanceLimited?: boolean
  notExplorable?: boolean
  block?: string[]
  featuredVaults?: string[]
  vaultOverrides?: Record<string, EulerLabelVaultOverride>
  keyring?: boolean
}

export type EulerLabelEarnVaultEntry = {
  address: string
  block?: string[]
  restricted?: string[]
  featured?: boolean
  deprecated?: boolean
  deprecationReason?: string
  description?: string
  portfolioNotice?: string
  notExplorable?: boolean
}
export type EulerLabelPoint = {
  name: string
  logo: string
  collateralVaults?: string[]
}

export type EulerLabelPointReward = {
  name: string
  logo: string
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

export const getEulerLabelEntityLogo = (fileName: string) => {
  const { EULER_LABELS_ENTITY_LOGO_URL } = useEulerConfig()
  return `${EULER_LABELS_ENTITY_LOGO_URL}/${fileName}`
}

export const getEntityLogoLocalPath = (fileName: string) => `/entities/${fileName}`
