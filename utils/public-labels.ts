import type { EulerLabelsData } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import type {
  EulerLabelEarnVaultEntry,
  EulerLabelEntity,
  EulerLabelPointReward,
  EulerLabelProduct,
  EulerLabelVaultOverride,
} from '~/entities/euler/labels'

export const PUBLIC_LABELS_RUNTIME_VERSION = 'latest'
export const PUBLIC_LABELS_FIXTURE_VERSION = 'v20260804151305236'
export const PUBLIC_LABELS_PAGE_SIZE = 100

const MAX_PUBLIC_LABEL_RECORDS = 10_000
const ENTITY_ADDRESS_CONCURRENCY = 8

export interface PublicLabelsMeta {
  total?: number
  limit?: number
  offset?: number
  timestamp: string
}

export interface PublicLabelsResponse<T> {
  data: T
  meta: PublicLabelsMeta
}

export interface PublicVaultCampaign {
  name: string
  logo: string | null
  type: 'deposit' | 'borrow'
}

export interface PublicVaultLabel {
  chainId: number
  address: string
  vaultType: 'evk' | 'earn' | 'securitize' | 'escrow'
  productId: string | null
  entityId: string | null
  name: string | null
  description: string | null
  portfolioNotice: string | null
  isDeprecated: boolean
  deprecationReason: string | null
  tags: string[]
  campaigns: PublicVaultCampaign[] | null
  createdAt: string
  updatedAt: string
}

export interface PublicProductLabel {
  id: string
  chainId: number
  entityId: string
  coBrandEntityIds?: string[] | null
  name: string
  logo?: string | null
  description: string | null
  url: string | null
  portfolioNotice: string | null
  isDeprecated: boolean
  deprecationReason: string | null
  governanceMode: string
  createdAt: string
  updatedAt: string
}

export interface PublicEntityLabel {
  id: string
  name: string
  logo: string | null
  description: string | null
  url: string | null
  socialTwitter: string | null
  socialYoutube: string | null
  socialDiscord: string | null
  socialTelegram: string | null
  socialGithub: string | null
  socialDefillama: string | null
  legalEntityName: string | null
  riskMethodology: string | null
  security: string | null
  termsOfService: string | null
  licenses: string | null
  disclaimers: string | null
  createdAt: string
  updatedAt: string
}

export interface PublicEntityAddress {
  entityId: string
  chainId: number
  address: string
  label: string | null
}

export interface PublicGeoPolicy {
  id: string
  chainId: number | null
  productId: string | null
  vaultAddress: string | null
  assetAddress: string | null
  assetSymbols?: string[] | null
  assetSymbolRegex?: string | null
  assetNames?: string[] | null
  assetNameRegex?: string | null
  countries: string[]
  policyType: 'block' | 'restrict'
  reason: string | null
  createdAt: string
}

export interface PublicLabelsSource {
  vaults: PublicVaultLabel[]
  products: PublicProductLabel[]
  entities: PublicEntityLabel[]
  entityAddresses: PublicEntityAddress[]
  geoPolicies: PublicGeoPolicy[]
}

export type PublicLabelsQuery = Record<string, string | number | undefined>
export type PublicLabelsRequest = <T>(
  path: string,
  query: PublicLabelsQuery,
) => Promise<PublicLabelsResponse<T>>

export type MigratedEulerLabelsData = Omit<EulerLabelsData, 'products' | 'entities'> & {
  products: Record<string, EulerLabelProduct>
  entities: Record<string, EulerLabelEntity>
  /** Versioned policy records are informational until effective precedence is specified. */
  rawGeoPolicies: PublicGeoPolicy[]
}

export const getEulerLabelProductBrandEntityKeys = (product: EulerLabelProduct): string[] => {
  const ownerKeys = Array.isArray(product.entity) ? product.entity : [product.entity]
  return [...new Set([...ownerKeys.filter(Boolean), ...(product.coBrandEntityIds ?? [])])]
}

export const getEulerLabelProductBrandEntities = (
  product: EulerLabelProduct,
  entities: Record<string, EulerLabelEntity>,
): EulerLabelEntity[] => getEulerLabelProductBrandEntityKeys(product)
  .map(key => entities[key])
  .filter((entity): entity is EulerLabelEntity => Boolean(entity))

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const assertListResponse = <T>(
  response: PublicLabelsResponse<T[]>,
  path: string,
): { items: T[], total: number } => {
  if (!response || !Array.isArray(response.data)) {
    throw new Error(`Invalid Public Labels response for ${path}`)
  }
  const total = response.meta?.total
  if (!isNonNegativeInteger(total) || total > MAX_PUBLIC_LABEL_RECORDS) {
    throw new Error(`Invalid Public Labels total for ${path}`)
  }
  return { items: response.data, total }
}

export const fetchAllPublicLabelPages = async <T>(
  request: PublicLabelsRequest,
  path: string,
  query: PublicLabelsQuery,
): Promise<T[]> => {
  const result: T[] = []
  let offset = 0

  while (true) {
    const response = await request<T[]>(path, {
      ...query,
      limit: PUBLIC_LABELS_PAGE_SIZE,
      offset,
    })
    const { items, total } = assertListResponse(response, path)
    result.push(...items)

    if (result.length >= total) return result.slice(0, total)
    if (items.length === 0) {
      throw new Error(`Public Labels pagination stalled for ${path}`)
    }
    offset += items.length
  }
}

const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> => {
  const result = new Array<R>(values.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      result[index] = await mapper(values[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  return result
}

const isSafeEntityId = (value: string): boolean => /^[A-Za-z0-9_-]{1,100}$/.test(value)

export const fetchPublicLabelsData = async (
  request: PublicLabelsRequest,
  chainId: number,
  version = PUBLIC_LABELS_RUNTIME_VERSION,
  legacy?: EulerLabelsData | Promise<EulerLabelsData>,
): Promise<MigratedEulerLabelsData> => {
  const [vaults, products, entities, geoPolicies, resolvedLegacy] = await Promise.all([
    fetchAllPublicLabelPages<PublicVaultLabel>(request, '/curation/vaults', { version, chainId }),
    fetchAllPublicLabelPages<PublicProductLabel>(request, '/products', { version, chainId }),
    fetchAllPublicLabelPages<PublicEntityLabel>(request, '/entities', { version }),
    fetchAllPublicLabelPages<PublicGeoPolicy>(request, '/geo-policies', { version }),
    Promise.resolve(legacy),
  ])

  const entityIds = [...new Set([
    ...products.flatMap(product => [product.entityId, ...(product.coBrandEntityIds ?? [])]),
    ...vaults.flatMap(vault => vault.entityId ? [vault.entityId] : []),
  ])].filter(isSafeEntityId)

  const entityAddressPages = await mapWithConcurrency(
    entityIds,
    ENTITY_ADDRESS_CONCURRENCY,
    entityId => fetchAllPublicLabelPages<PublicEntityAddress>(
      request,
      `/entities/${entityId}/addresses`,
      { chainId, version },
    ),
  )

  return normalizePublicLabelsData(chainId, {
    vaults,
    products,
    entities,
    entityAddresses: entityAddressPages.flat(),
    geoPolicies,
  }, resolvedLegacy)
}

const uniqueStrings = (values: Iterable<string>): string[] => [...new Set(values)]

const present = <T>(value: T | null | undefined): T | undefined =>
  value === null || value === undefined ? undefined : value

const makeVaultOverride = (vault: PublicVaultLabel): EulerLabelVaultOverride => ({
  ...present(vault.name) !== undefined && { name: vault.name! },
  ...present(vault.description) !== undefined && { description: vault.description! },
  ...present(vault.portfolioNotice) !== undefined && { portfolioNotice: vault.portfolioNotice! },
  ...present(vault.deprecationReason) !== undefined && { deprecationReason: vault.deprecationReason! },
  ...(vault.tags.length > 0 && { tags: [...vault.tags] }),
})

const buildEntity = (
  entity: PublicEntityLabel,
  addresses: PublicEntityAddress[],
): EulerLabelEntity => ({
  id: entity.id,
  name: entity.name,
  logo: entity.logo ?? '',
  description: entity.description ?? '',
  url: entity.url ?? '',
  ...present(entity.legalEntityName) !== undefined && { legalEntityName: entity.legalEntityName! },
  ...present(entity.riskMethodology) !== undefined && { riskMethodology: entity.riskMethodology! },
  ...present(entity.security) !== undefined && { security: entity.security! },
  ...present(entity.termsOfService) !== undefined && { termsOfService: entity.termsOfService! },
  ...present(entity.licenses) !== undefined && { licenses: entity.licenses! },
  ...present(entity.disclaimers) !== undefined && { disclaimers: entity.disclaimers! },
  addresses: Object.fromEntries(addresses.map(entry => [getAddress(entry.address), entry.label ?? ''])),
  social: {
    twitter: entity.socialTwitter ?? '',
    youtube: entity.socialYoutube ?? '',
    discord: entity.socialDiscord ?? '',
    telegram: entity.socialTelegram ?? '',
    github: entity.socialGithub ?? '',
    defillama: entity.socialDefillama ?? '',
  },
})

const productTags = (vaults: PublicVaultLabel[]): string[] | undefined => {
  const tags = uniqueStrings(vaults.flatMap(vault => vault.tags))
  return tags.length > 0 ? tags : undefined
}

const buildProduct = (
  product: PublicProductLabel,
  vaults: PublicVaultLabel[],
): EulerLabelProduct => {
  const active: string[] = []
  const deprecated: string[] = []
  const vaultOverrides: Record<string, EulerLabelVaultOverride> = {}

  for (const vault of vaults) {
    const address = getAddress(vault.address)
    if (vault.isDeprecated) deprecated.push(address)
    else active.push(address)
    vaultOverrides[address] = makeVaultOverride(vault)
  }

  const tags = productTags(vaults)
  return {
    id: product.id,
    chainId: product.chainId,
    name: product.name,
    description: product.description ?? '',
    ...(product.portfolioNotice && { portfolioNotice: product.portfolioNotice }),
    entity: product.entityId,
    coBrandEntityIds: [...(product.coBrandEntityIds ?? [])],
    url: product.url ?? '',
    ...(product.logo && { logo: product.logo }),
    vaults: active,
    deprecatedVaults: deprecated,
    ...(product.deprecationReason && { deprecationReason: product.deprecationReason }),
    ...(product.isDeprecated && { isDeprecated: true }),
    ...(tags && { tags }),
    vaultOverrides,
  }
}

const standaloneProductKey = (address: string): string => `__vault_${address.toLowerCase()}`

/**
 * The inventory is a union of label and assessment records. A row with only
 * identity/type/timestamps is assessment-only and must not affect listing or
 * verification state.
 */
export const hasPublishedVaultLabelContent = (vault: PublicVaultLabel): boolean => Boolean(
  vault.productId
  || vault.entityId
  || vault.name
  || vault.description
  || vault.portfolioNotice
  || vault.isDeprecated
  || vault.deprecationReason
  || vault.tags.length
  || vault.campaigns?.length,
)

const buildStandaloneProduct = (vault: PublicVaultLabel): EulerLabelProduct => {
  const address = getAddress(vault.address)
  return {
    id: standaloneProductKey(address),
    chainId: vault.chainId,
    isStandalone: true,
    name: vault.name ?? '',
    description: vault.description ?? '',
    ...(vault.portfolioNotice && { portfolioNotice: vault.portfolioNotice }),
    entity: vault.entityId ?? '',
    coBrandEntityIds: [],
    url: '',
    vaults: vault.isDeprecated ? [] : [address],
    deprecatedVaults: vault.isDeprecated ? [address] : [],
    ...(vault.deprecationReason && { deprecationReason: vault.deprecationReason }),
    ...(vault.tags.length > 0 && { tags: [...vault.tags] }),
    vaultOverrides: { [address]: makeVaultOverride(vault) },
  }
}

export const normalizePublicLabelsData = (
  chainId: number,
  source: PublicLabelsSource,
  legacy?: EulerLabelsData,
): MigratedEulerLabelsData => {
  const inventoryRows = source.vaults.filter(vault => vault.chainId === chainId)
  const chainVaults = inventoryRows.filter(hasPublishedVaultLabelContent)
  const compatibilityVerified = new Set(
    (legacy?.verifiedVaultAddresses ?? []).map(address => address.toLowerCase()),
  )
  const compatibilityEarn = new Set(
    (legacy?.earnVaults ?? []).map(address => address.toLowerCase()),
  )
  // Plain-address labels and assessment-only rows have the same empty content
  // shape in the inventory. Retain an empty row only when the compatibility
  // snapshot already classifies that exact published inventory address.
  const compatibilityEarnRows = inventoryRows.filter(vault =>
    !hasPublishedVaultLabelContent(vault)
    && vault.vaultType === 'earn'
    && compatibilityEarn.has(vault.address.toLowerCase()),
  )
  const compatibilityVerifiedRows = inventoryRows.filter(vault =>
    !hasPublishedVaultLabelContent(vault)
    && vault.vaultType !== 'earn'
    && vault.vaultType !== 'escrow'
    && compatibilityVerified.has(vault.address.toLowerCase()),
  )
  const productRows = source.products.filter(product => product.chainId === chainId)
  const vaultsByProduct = new Map<string, PublicVaultLabel[]>()
  for (const vault of chainVaults) {
    if (!vault.productId) continue
    const rows = vaultsByProduct.get(vault.productId) ?? []
    rows.push(vault)
    vaultsByProduct.set(vault.productId, rows)
  }

  const products: Record<string, EulerLabelProduct> = {}
  for (const product of productRows) {
    products[product.id] = buildProduct(product, vaultsByProduct.get(product.id) ?? [])
  }

  for (const vault of chainVaults) {
    if (vault.productId) {
      if (!products[vault.productId]) {
        throw new Error(`Public Labels vault references missing product ${vault.productId}`)
      }
      continue
    }
    if (vault.vaultType !== 'earn' && vault.vaultType !== 'escrow') {
      products[standaloneProductKey(vault.address)] = buildStandaloneProduct(vault)
    }
  }

  const addressesByEntity = new Map<string, PublicEntityAddress[]>()
  for (const address of source.entityAddresses) {
    if (address.chainId !== chainId) continue
    const rows = addressesByEntity.get(address.entityId) ?? []
    rows.push(address)
    addressesByEntity.set(address.entityId, rows)
  }
  const entities = Object.fromEntries(source.entities.map(entity => [
    entity.id,
    buildEntity(entity, addressesByEntity.get(entity.id) ?? []),
  ])) as Record<string, EulerLabelEntity>

  const verifiedVaultAddresses: string[] = compatibilityVerifiedRows.map(vault => getAddress(vault.address))
  const earnVaults: string[] = []
  const earnVaultEntries: Record<string, EulerLabelEarnVaultEntry> = {}
  const earnVaultBlocks: Record<string, string[]> = { ...(legacy?.earnVaultBlocks ?? {}) }
  const earnVaultRestrictions: Record<string, string[]> = { ...(legacy?.earnVaultRestrictions ?? {}) }
  const deprecatedEarnVaults: Record<string, string> = {}
  const earnVaultDescriptions: Record<string, string> = {}
  const earnVaultNotices: Record<string, string> = {}
  const notExplorableEarnVaults = new Set<string>(legacy?.notExplorableEarnVaults ?? [])
  const points: Record<string, EulerLabelPointReward[]> = {}
  for (const vault of [...chainVaults, ...compatibilityEarnRows]) {
    const address = getAddress(vault.address)
    const lower = address.toLowerCase()
    if (vault.vaultType === 'earn') {
      earnVaults.push(address)
      earnVaultEntries[lower] = {
        address,
        ...(vault.tags.length > 0 && { tags: [...vault.tags] }),
        ...(vault.isDeprecated && { deprecated: true }),
        ...(vault.deprecationReason && { deprecationReason: vault.deprecationReason }),
        ...(vault.description && { description: vault.description }),
        ...(vault.portfolioNotice && { portfolioNotice: vault.portfolioNotice }),
      }
      if (vault.isDeprecated) deprecatedEarnVaults[lower] = vault.deprecationReason ?? ''
      if (vault.description) earnVaultDescriptions[lower] = vault.description
      if (vault.portfolioNotice) earnVaultNotices[lower] = vault.portfolioNotice
    }
    else if (vault.vaultType !== 'escrow') {
      verifiedVaultAddresses.push(address)
    }

    if (vault.campaigns?.length) {
      points[address] = vault.campaigns.map(campaign => ({
        name: campaign.name,
        logo: campaign.logo ?? '',
        type: campaign.type,
      }))
    }
  }

  // Preserve the currently effective geo/visibility data. Raw V3 geo policies
  // are intentionally not composed here: global/product/vault/asset precedence
  // and the final eligibility contract are not specified yet.
  for (const [productKey, product] of Object.entries(products)) {
    const legacyProduct = legacy?.products?.[productKey] as EulerLabelProduct | undefined
    if (!legacyProduct) continue
    product.block = legacyProduct.block
    product.restricted = legacyProduct.restricted
    product.notExplorable = legacyProduct.notExplorable
    for (const address of [...product.vaults, ...(product.deprecatedVaults ?? [])]) {
      const target = product.vaultOverrides?.[address]
      const previous = legacyProduct.vaultOverrides?.[address]
      if (!target || !previous) continue
      target.block = previous.block
      target.restricted = previous.restricted
      target.notExplorableLend = previous.notExplorableLend
      target.notExplorableBorrow = previous.notExplorableBorrow
    }
  }
  for (const [address, entry] of Object.entries(earnVaultEntries)) {
    const previous = legacy?.earnVaultEntries?.[address]
    if (!previous) continue
    entry.block = previous.block
    entry.restricted = previous.restricted
    entry.notExplorable = previous.notExplorable
  }

  return {
    products,
    entities,
    points,
    verifiedVaultAddresses: uniqueStrings(verifiedVaultAddresses),
    earnVaults: uniqueStrings(earnVaults),
    earnVaultEntries,
    earnVaultBlocks,
    earnVaultRestrictions,
    deprecatedEarnVaults,
    earnVaultDescriptions,
    earnVaultNotices,
    notExplorableEarnVaults,
    assetBlocks: { ...(legacy?.assetBlocks ?? {}) },
    assetRestrictions: { ...(legacy?.assetRestrictions ?? {}) },
    assetPatternRules: [...(legacy?.assetPatternRules ?? [])],
    rawGeoPolicies: source.geoPolicies.filter(policy =>
      policy.chainId === null || policy.chainId === chainId,
    ),
  } as MigratedEulerLabelsData
}
