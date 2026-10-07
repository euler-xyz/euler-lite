import { createHash } from 'node:crypto'

type IssueLike = Record<string, unknown>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export interface SafeUrlLogFields {
  upstreamHost?: string
  searchKeys: string[]
}

export interface SafeErrorLogFields {
  name: string
  status?: number
  code?: string | number
  causeName?: string
}

export function hashIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 16)
}

export function urlHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return new URL(value).host
  }
  catch {
    return undefined
  }
}

export function safePathTemplate(pathname: string): string {
  return pathname
    .split('/')
    .map((part) => {
      if (ADDRESS_RE.test(part)) return ':address'
      if (/^[0-9]+$/.test(part)) return ':number'
      return part
    })
    .join('/')
}

export function searchKeys(params: URLSearchParams): string[] {
  return [...new Set([...params.keys()])].sort()
}

export function safeUrlLogFields(value: unknown): SafeUrlLogFields {
  if (typeof value !== 'string' || !value.trim()) {
    return { searchKeys: [] }
  }
  try {
    const url = new URL(value)
    return {
      upstreamHost: url.host,
      searchKeys: searchKeys(url.searchParams),
    }
  }
  catch {
    return {
      upstreamHost: urlHost(value),
      searchKeys: [],
    }
  }
}

export function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown, statusCode?: unknown }).status
    ?? (error as { status?: unknown, statusCode?: unknown }).statusCode
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

const errorCode = (error: unknown): string | number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

const errorCauseName = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error ? cause.name : undefined
}

export function safeErrorLogFields(error: unknown): SafeErrorLogFields {
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(errorStatus(error) !== undefined ? { status: errorStatus(error) } : {}),
    ...(errorCode(error) !== undefined ? { code: errorCode(error) } : {}),
    ...(errorCauseName(error) !== undefined ? { causeName: errorCauseName(error) } : {}),
  }
}

const MAX_LOGGED_ISSUE_LOCATIONS = 5
const MAX_LOGGED_PATH_LENGTH = 120
const MAX_LOGGED_LABEL_LENGTH = 64

export interface VaultAssetRef {
  address: string
  symbol?: string
}

export type VaultAssetLookup = (vault: string) => VaultAssetRef | undefined

const addressOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && ADDRESS_RE.test(value) ? value : undefined

const withoutUndefined = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

export function buildVaultAssetLookup(vaults: readonly unknown[]): VaultAssetLookup {
  const byVault = new Map<string, VaultAssetRef>()
  for (const vault of vaults) {
    if (!vault || typeof vault !== 'object') continue
    const { address, asset } = vault as { address?: unknown, asset?: { address?: unknown, symbol?: unknown } }
    const vaultAddress = addressOrUndefined(address)
    const assetAddress = addressOrUndefined(asset?.address)
    if (!vaultAddress || !assetAddress) continue
    const symbol = typeof asset?.symbol === 'string' && asset.symbol.trim()
      ? asset.symbol.slice(0, MAX_LOGGED_LABEL_LENGTH)
      : undefined
    byVault.set(vaultAddress.toLowerCase(), symbol ? { address: assetAddress, symbol } : { address: assetAddress })
  }
  return vault => byVault.get(vault.toLowerCase())
}

const assetOfVault = (vault: string | undefined, lookup: VaultAssetLookup | undefined) => {
  const asset = vault && lookup ? lookup(vault) : undefined
  return asset ? { asset: asset.address, assetSymbol: asset.symbol } : {}
}

const accountHash = (value: unknown) => hashIdentifier(addressOrUndefined(value))

const OWNER_FIELDS: Record<string, (owner: IssueLike, lookup?: VaultAssetLookup) => Record<string, unknown>> = {
  asset: owner => ({ asset: addressOrUndefined(owner.address) }),
  vault: (owner, lookup) => ({ vault: addressOrUndefined(owner.address), ...assetOfVault(addressOrUndefined(owner.address), lookup) }),
  vaultCollateral: (owner, lookup) => ({
    vault: addressOrUndefined(owner.vault),
    collateral: addressOrUndefined(owner.collateral),
    ...assetOfVault(addressOrUndefined(owner.collateral), lookup),
  }),
  vaultStrategy: owner => ({ vault: addressOrUndefined(owner.vault), strategy: addressOrUndefined(owner.strategy) }),
  accountPosition: (owner, lookup) => ({
    vault: addressOrUndefined(owner.vault),
    ...assetOfVault(addressOrUndefined(owner.vault), lookup),
    account: accountHash(owner.account),
  }),
  accountPositionCollateral: (owner, lookup) => ({
    vault: addressOrUndefined(owner.vault),
    collateral: addressOrUndefined(owner.collateral),
    ...assetOfVault(addressOrUndefined(owner.collateral), lookup),
    account: accountHash(owner.account),
  }),
  account: owner => ({ account: accountHash(owner.address) }),
  subAccount: owner => ({ account: accountHash(owner.address) }),
  wallet: owner => ({ account: accountHash(owner.address) }),
  walletAsset: owner => ({ account: accountHash(owner.wallet), asset: addressOrUndefined(owner.asset) }),
  service: owner => ({ service: typeof owner.service === 'string' ? owner.service.slice(0, MAX_LOGGED_LABEL_LENGTH) : undefined }),
}

function summarizeIssueLocation(location: unknown, lookup?: VaultAssetLookup): Record<string, unknown> | undefined {
  if (!location || typeof location !== 'object') return undefined
  const { owner, path } = location as { owner?: unknown, path?: unknown }
  if (!owner || typeof owner !== 'object') return undefined
  const { kind, chainId } = owner as IssueLike
  const fields = typeof kind === 'string' && Object.hasOwn(OWNER_FIELDS, kind) ? OWNER_FIELDS[kind] : undefined
  if (!fields) return undefined
  return withoutUndefined({
    kind,
    chainId: Number.isSafeInteger(chainId) ? chainId : undefined,
    ...fields(owner as IssueLike, lookup),
    path: typeof path === 'string' ? path.slice(0, MAX_LOGGED_PATH_LENGTH) : undefined,
  })
}

function summarizeIssueLocations(locations: unknown, lookup?: VaultAssetLookup): Record<string, unknown> {
  const summarized = (Array.isArray(locations) ? locations : [])
    .map(location => summarizeIssueLocation(location, lookup))
    .filter((location): location is Record<string, unknown> => location !== undefined)
  if (!summarized.length) return {}
  return {
    locations: summarized.slice(0, MAX_LOGGED_ISSUE_LOCATIONS),
    ...(summarized.length > MAX_LOGGED_ISSUE_LOCATIONS ? { locationCount: summarized.length } : {}),
  }
}

export function summarizeSdkIssue(issue: unknown, assetForVault?: VaultAssetLookup): Record<string, unknown> {
  if (!issue || typeof issue !== 'object') {
    return { type: typeof issue }
  }

  const src = issue as IssueLike
  const out: Record<string, unknown> = {}
  for (const key of ['code', 'kind', 'severity', 'source', 'type', 'name']) {
    const value = src[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }

  const message = src.message ?? src.shortMessage
  if (typeof message === 'string' && message.trim()) {
    out.message = message.slice(0, 240)
  }

  const summary = { ...out, ...summarizeIssueLocations(src.locations, assetForVault) }
  return Object.keys(summary).length ? summary : { type: 'sdk-issue' }
}
