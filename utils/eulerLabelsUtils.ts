import {
  type EulerLabelEntity,
  type EulerLabelProduct,
  eulerLabelProductEmpty,
  type EulerLabelVaultOverride,
} from '~/entities/euler/labels'
import type { EarnVault } from '~/entities/vault'
import { type OracleAdapterMeta, OracleAdapterCheckSeverity } from '~/entities/oracle'
import { normalizeAddress } from '~/utils/normalizeAddress'
import {
  products,
  entities,
  points,
  earnVaultBlocks,
  earnVaultRestrictions,
  featuredEarnVaults,
  deprecatedEarnVaults,
  earnVaultDescriptions,
  earnVaultNotices,
  notExplorableEarnVaults,
  assetBlocks,
  assetRestrictions,
  assetPatternRules,
  wrapPairs,
  type CompiledPatternRule,
} from '~/utils/eulerLabelsState'

// Cap inputs passed to regex .test() to protect against catastrophic
// backtracking if a curator ships a poorly-formed pattern and an on-chain
// token returns an attacker-chosen long symbol/name. Real ERC-20 symbols are
// typically <=12 chars and names <=64; 128 is well above any legitimate value.
const MAX_REGEX_INPUT_LEN = 128

/**
 * Test whether an asset-pattern rule matches the given lowercased symbol/name.
 * OR across populated fields — any match wins. Shared by the country-resolution
 * helpers in `useGeoBlock` and the wrap-pair discovery step in `useEulerLabels`.
 */
export const patternRuleMatches = (
  rule: CompiledPatternRule,
  symbolLower: string | undefined,
  nameLower: string | undefined,
): boolean => {
  if (rule.symbolsLower && symbolLower && rule.symbolsLower.has(symbolLower)) return true
  if (rule.symbolRegex && symbolLower && symbolLower.length <= MAX_REGEX_INPUT_LEN && rule.symbolRegex.test(symbolLower)) return true
  if (rule.namesLower && nameLower && rule.namesLower.has(nameLower)) return true
  if (rule.nameRegex && nameLower && nameLower.length <= MAX_REGEX_INPUT_LEN && rule.nameRegex.test(nameLower)) return true
  return false
}

/**
 * True when the asset matches any active soft-restrict rule (address-based or
 * pattern-based). Used by the wrap-pair discovery step to scope its multicall
 * to only the assets whose output side could be soft-restricted in some
 * region — for which a wrap-pair bypass might apply.
 */
export const assetMatchesAnyRestrictRule = (
  asset: { address: string, symbol?: string, name?: string },
): boolean => {
  const addrLower = asset.address.toLowerCase()
  if (assetRestrictions[addrLower]?.length) return true
  const symbolLower = asset.symbol?.toLowerCase()
  const nameLower = asset.name?.toLowerCase()
  if (!symbolLower && !nameLower) return false
  for (const rule of assetPatternRules) {
    if (!rule.restricted?.length) continue
    if (patternRuleMatches(rule, symbolLower, nameLower)) return true
  }
  return false
}

/**
 * True when `a` and `b` are an ERC-4626 wrap pair in either direction — i.e.
 * one's address is the other's `asset()` underlying, per the map populated by
 * the labels loader. Consulted by `isAssetRestrictedByCountry` to bypass the
 * soft-restrict gate when an operation is a technical wrap/unwrap.
 */
export const isWrapPair = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return false
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  return wrapPairs[al] === bl || wrapPairs[bl] === al
}

// ── Internal helpers ─────────────────────────────────────────

// This check reflects internal indexing state,
// not an oracle health signal surfaced to end users.
const SUPPRESSED_CHECK_ID = 'Adapter whitelist'

function isHttpUrl(value: string): boolean {
  if (!value) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

// ── Normalization helpers ────────────────────────────────────

export const extractVaultOverrides = (raw: Record<string, unknown>): Record<string, EulerLabelVaultOverride> => {
  const overrides: Record<string, EulerLabelVaultOverride> = {}
  for (const [key, value] of Object.entries(raw.vaultOverrides || {})) {
    if (!key.startsWith('0x') || typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const override: EulerLabelVaultOverride = {}
    if (typeof entry.name === 'string') override.name = entry.name
    if (typeof entry.description === 'string') override.description = entry.description
    if (typeof entry.portfolioNotice === 'string') override.portfolioNotice = entry.portfolioNotice
    const reason = entry.deprecationReason ?? entry.deprecateReason
    if (typeof reason === 'string') override.deprecationReason = reason
    if (Array.isArray(entry.block)) override.block = entry.block.filter((v): v is string => typeof v === 'string')
    if (Array.isArray(entry.restricted)) override.restricted = entry.restricted.filter((v): v is string => typeof v === 'string')
    if (typeof entry.notExplorableLend === 'boolean') override.notExplorableLend = entry.notExplorableLend
    if (typeof entry.notExplorableBorrow === 'boolean') override.notExplorableBorrow = entry.notExplorableBorrow
    if (typeof entry.keyring === 'boolean') override.keyring = entry.keyring
    if (Object.keys(override).length > 0) {
      overrides[normalizeAddress(key)] = override
    }
  }
  return overrides
}

export const normalizeProducts = (data: Record<string, EulerLabelProduct>): { products: Record<string, EulerLabelProduct>, vaultAddresses: string[] } => {
  const normalized: Record<string, EulerLabelProduct> = {}
  const allVaults = new Set<string>()
  Object.entries(data).forEach(([key, product]) => {
    const normalizedVaults = product.vaults.map(normalizeAddress)
    const normalizedDeprecated = (product.deprecatedVaults || []).map(normalizeAddress)
    const fallbackReason = (product as { deprecateReason?: string }).deprecateReason
    const vaultOverrides = extractVaultOverrides(product as unknown as Record<string, unknown>)
    normalized[key] = {
      ...product,
      vaults: normalizedVaults,
      deprecatedVaults: normalizedDeprecated,
      deprecationReason: product.deprecationReason || fallbackReason,
      vaultOverrides,
    }
    normalizedVaults.forEach(v => allVaults.add(v))
    normalizedDeprecated.forEach(v => allVaults.add(v))
  })
  return { products: normalized, vaultAddresses: [...allVaults] }
}

export const normalizeEntities = (data: Record<string, EulerLabelEntity>) => {
  const normalized: Record<string, EulerLabelEntity> = {}
  Object.entries(data).forEach(([key, entity]) => {
    const normalizedAddresses: Record<string, string> = {}
    Object.entries(entity.addresses || {}).forEach(([address, label]) => {
      normalizedAddresses[normalizeAddress(address)] = label
    })
    normalized[key] = {
      ...entity,
      addresses: normalizedAddresses,
      url: isHttpUrl(entity.url) ? entity.url : '',
    }
  })
  return normalized
}

export const normalizeOracleAdapters = (data: unknown) => {
  const normalized: Record<string, OracleAdapterMeta> = {}
  const list = Array.isArray(data) ? data : ((data as { adapters?: unknown[] })?.adapters || [])

  list.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const raw = item as Record<string, unknown>
    const oracle = raw.oracle || raw.adapter || raw.address
    if (typeof oracle !== 'string') return

    const base = raw.base || raw.baseAsset || raw.base_asset
    const quote = raw.quote || raw.quoteAsset || raw.quote_asset
    const baseAddress = typeof base === 'string' ? normalizeAddress(base) : undefined
    const quoteAddress = typeof quote === 'string' ? normalizeAddress(quote) : undefined

    const meta: OracleAdapterMeta = {
      oracle: normalizeAddress(oracle),
      base: baseAddress,
      quote: quoteAddress,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      provider: typeof raw.provider === 'string' ? raw.provider : undefined,
      methodology: typeof raw.methodology === 'string' ? raw.methodology : undefined,
      label: typeof raw.label === 'string' ? raw.label : undefined,
      checks: Array.isArray(raw.checks)
        ? raw.checks
            .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
            .filter(c => c.id !== SUPPRESSED_CHECK_ID)
            .map(c => ({
              id: typeof c.id === 'string' ? c.id : '',
              message: typeof c.message === 'string' ? c.message : '',
              pass: typeof c.pass === 'boolean' ? c.pass : false,
              severity: Object.values(OracleAdapterCheckSeverity).includes(c.severity as OracleAdapterCheckSeverity)
                ? c.severity as OracleAdapterCheckSeverity
                : OracleAdapterCheckSeverity.Info,
            }))
        : undefined,
    }

    normalized[meta.oracle.toLowerCase()] = meta
  })

  return normalized
}

// ── Getters ──────────────────────────────────────────────────

export const getProductByVault = (vaultAddress: string) => {
  const normalized = normalizeAddress(vaultAddress)
  return Object.values(products).find(product =>
    product.vaults.includes(normalized)
    || product.deprecatedVaults?.includes(normalized),
  )
  || eulerLabelProductEmpty
}

export const getProductKeyByVault = (vaultAddress: string): string | undefined => {
  const normalized = normalizeAddress(vaultAddress)
  return Object.keys(products).find((key) => {
    const product = products[key]
    return product.vaults.includes(normalized)
      || product.deprecatedVaults?.includes(normalized)
  })
}

export const getVaultBlock = (vaultAddress: string): string[] | undefined => {
  const product = getProductByVault(vaultAddress)
  const override = product.vaultOverrides?.[normalizeAddress(vaultAddress)]
  return override?.block ?? product.block
}

export const getEarnVaultBlock = (vaultAddress: string): string[] | undefined => {
  const normalized = normalizeAddress(vaultAddress).toLowerCase()
  return earnVaultBlocks[normalized]
}

export const getVaultRestricted = (vaultAddress: string): string[] | undefined => {
  const product = getProductByVault(vaultAddress)
  return product.vaultOverrides?.[normalizeAddress(vaultAddress)]?.restricted
}

export const getEarnVaultRestricted = (vaultAddress: string): string[] | undefined => {
  const normalized = normalizeAddress(vaultAddress).toLowerCase()
  return earnVaultRestrictions[normalized]
}

export const getAssetBlock = (assetAddress: string): string[] | undefined => {
  if (!assetAddress) return undefined
  const normalized = normalizeAddress(assetAddress).toLowerCase()
  return assetBlocks[normalized]
}

export const getAssetRestricted = (assetAddress: string): string[] | undefined => {
  if (!assetAddress) return undefined
  const normalized = normalizeAddress(assetAddress).toLowerCase()
  return assetRestrictions[normalized]
}

export const isVaultFeatured = (vaultAddress: string): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const inFeaturedProduct = Object.values(products).some(product =>
    product.featuredVaults?.includes(normalized) ?? false,
  )
  if (inFeaturedProduct) return true
  return featuredEarnVaults.has(normalized)
}

export const isEarnVaultDeprecated = (vaultAddress: string): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  return normalized.toLowerCase() in deprecatedEarnVaults
}

export const isEarnVaultNotExplorable = (vaultAddress: string): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  return notExplorableEarnVaults.has(normalized.toLowerCase())
}

export const getEarnVaultDeprecationReason = (vaultAddress: string): string => {
  const normalized = normalizeAddress(vaultAddress)
  return deprecatedEarnVaults[normalized.toLowerCase()] ?? ''
}

export const getEarnVaultDescription = (vaultAddress: string): string => {
  const normalized = normalizeAddress(vaultAddress)
  return earnVaultDescriptions[normalized.toLowerCase()] ?? ''
}

export const getEarnVaultNotice = (vaultAddress: string): string => {
  const normalized = normalizeAddress(vaultAddress)
  return earnVaultNotices[normalized.toLowerCase()] ?? ''
}

export const getVaultNotice = (vaultAddress: string): string => {
  const earnNotice = getEarnVaultNotice(vaultAddress)
  if (earnNotice) return earnNotice

  const normalized = normalizeAddress(vaultAddress)
  const product = getProductByVault(normalized)
  const override = product.vaultOverrides?.[normalized]
  if (override?.portfolioNotice !== undefined) return override.portfolioNotice

  return product.portfolioNotice ?? ''
}

/** Returns true when the notice is vault-specific (earn entry or vault override), false when product-level */
export const isVaultNoticeSpecific = (vaultAddress: string): boolean => {
  if (getEarnVaultNotice(vaultAddress)) return true
  const normalized = normalizeAddress(vaultAddress)
  const product = getProductByVault(normalized)
  return product.vaultOverrides?.[normalized]?.portfolioNotice !== undefined
}

export const isVaultDeprecated = (vaultAddress: string): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  if (normalized.toLowerCase() in deprecatedEarnVaults) return true
  return Object.values(products).some(product =>
    product.deprecatedVaults?.includes(normalized) ?? false,
  )
}

export const isVaultNotExplorable = (vaultAddress: string): boolean => {
  const product = getProductByVault(vaultAddress)
  return product.notExplorable === true
}

export const isVaultNotExplorableLend = (vaultAddress: string): boolean => {
  const product = getProductByVault(vaultAddress)
  if (product.notExplorable === true) return true
  const override = product.vaultOverrides?.[normalizeAddress(vaultAddress)]
  return override?.notExplorableLend === true
}

export const isVaultNotExplorableBorrow = (vaultAddress: string): boolean => {
  const product = getProductByVault(vaultAddress)
  if (product.notExplorable === true) return true
  const override = product.vaultOverrides?.[normalizeAddress(vaultAddress)]
  return override?.notExplorableBorrow === true
}

export const isVaultKeyring = (vaultAddress: string): boolean => {
  const product = getProductByVault(vaultAddress)
  if (product.keyring === true) return true
  const override = product.vaultOverrides?.[normalizeAddress(vaultAddress)]
  return override?.keyring === true
}

export const isProductKeyring = (productKey: string): boolean => {
  return products[productKey]?.keyring === true
}

// Widened to Vault | SecuritizeVault — both expose governorAdmin: string and
// the helper only reads that one field. Callers from the discovery matrix
// pass either type without casting.
export const getEntitiesByVault = (vault: { governorAdmin: string }) => {
  const arr: EulerLabelEntity[] = []
  Object.values(entities).forEach((entity) => {
    if (Object.keys(entity.addresses).includes(vault.governorAdmin)) {
      arr.push(entity)
    }
  })
  return arr
}

export const getEntitiesByEarnVault = (earnVault: EarnVault) => {
  const arr: EulerLabelEntity[] = []
  const ownerAddress = normalizeAddress(earnVault.owner)

  Object.values(entities).forEach((entity) => {
    if (entity.addresses && Object.keys(entity.addresses).includes(ownerAddress)) {
      arr.push(entity)
    }
  })

  return arr
}

export const getPointsByVault = (vaultAddress: string) => {
  return points[normalizeAddress(vaultAddress)] || []
}

export const applyVaultOverrides = (product: EulerLabelProduct, vaultAddress: string): EulerLabelProduct => {
  const override = product.vaultOverrides?.[normalizeAddress(vaultAddress)]
  if (!override) return product
  return {
    ...product,
    ...(override.name !== undefined && { name: override.name }),
    ...(override.description !== undefined && { description: override.description }),
    ...(override.portfolioNotice !== undefined && { portfolioNotice: override.portfolioNotice }),
    ...(override.deprecationReason !== undefined && { deprecationReason: override.deprecationReason }),
  }
}

export const getVaultProductName = (vaultAddress: string): string => {
  const product = getProductByVault(vaultAddress)
  return applyVaultOverrides(product, vaultAddress).name
}
