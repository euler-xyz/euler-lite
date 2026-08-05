export type EulerLabelEntity = {
  id?: string
  name: string
  logo: string
  description: string
  url: string
  legalEntityName?: string
  riskMethodology?: string
  security?: string
  termsOfService?: string
  licenses?: string
  disclaimers?: string
  addresses: Record<string, string>
  social: {
    twitter: string
    youtube: string
    discord: string
    telegram: string
    github: string
    [key: string]: string | undefined
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
  tags?: string[]
}

export type EulerLabelProduct = {
  id?: string
  chainId?: number
  name: string
  description: string
  portfolioNotice?: string
  entity: string[] | string
  /** Display-only brand partners. These do not participate in manager verification. */
  coBrandEntityIds?: string[]
  isDeprecated?: boolean
  /** Local compatibility wrapper for a labeled vault that has no product. */
  isStandalone?: boolean
  url: string
  vaults: string[]
  deprecatedVaults?: string[]
  deprecationReason?: string
  notExplorable?: boolean
  block?: string[]
  restricted?: string[]
  vaultOverrides?: Record<string, EulerLabelVaultOverride>
  // Freeform classification tags, e.g. 'keyring', 'access control', or
  // 'governance limited'. Replaces the former bespoke classification booleans.
  tags?: string[]
}

export type EulerLabelEarnVaultEntry = {
  address: string
  block?: string[]
  restricted?: string[]
  tags?: string[]
  deprecated?: boolean
  deprecationReason?: string
  description?: string
  portfolioNotice?: string
  notExplorable?: boolean
}

/**
 * Asset-level geo-blocking entry. At least one match field
 * (`address` | `symbols` | `symbolRegex` | `names` | `nameRegex`) must be
 * set. When multiple match fields are set they are OR-composed: the entry
 * matches an asset if ANY populated match field matches.
 *
 * All string comparisons (`symbols`, `names`) are case-insensitive. Regex
 * fields are compiled with the `i` flag at load time. Invalid regexes are
 * dropped with a warning.
 *
 * `block` (hard) and `restricted` (soft) follow the same semantics as
 * vault-level rules; countries accept the `EU` / `EEA` / `EFTA` aliases.
 */
export type EulerLabelAssetEntry = {
  address?: string
  symbols?: string[]
  symbolRegex?: string
  names?: string[]
  nameRegex?: string
  block?: string[]
  restricted?: string[]
}
export type EulerLabelPoint = {
  name: string
  logo: string
  collateralVaults?: string[]
}

export type EulerLabelPointReward = {
  name: string
  logo: string
  type?: 'deposit' | 'borrow'
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
  if (/^https?:\/\//i.test(fileName)) return fileName
  const { EULER_LABELS_ENTITY_LOGO_URL } = useEulerConfig()
  return `${EULER_LABELS_ENTITY_LOGO_URL}/${fileName}`
}

export const getEulerLabelPointLogo = (fileName: string) =>
  /^https?:\/\//i.test(fileName) ? fileName : `/entities/${fileName}`

export const getEntityLogoLocalPath = (fileName: string) => `/entities/${fileName}`
