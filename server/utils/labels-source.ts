import { getAddress } from 'viem'
import { createTtlCache } from './cache'
import { fetchWithTimeout } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { resolveLabelsFileUrl } from './labels-base-url'
import { reportStatus } from './log'
import type { EffectiveLabelsSource } from '~/utils/public-labels'
import type { EulerLabelAssetEntry } from '~/entities/euler/labels'

const CACHE_TTL_MS = 300_000

export const EFFECTIVE_POLICY_LABEL_FILES = ['products.json', 'earn-vaults.json', 'assets.json'] as const

export type LabelFile = typeof EFFECTIVE_POLICY_LABEL_FILES[number]
export type LabelScope = number | 'all'

const EMPTY_SHAPES: Record<LabelFile, unknown> = {
  'products.json': {},
  'earn-vaults.json': [],
  'assets.json': [],
}

const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS })
const inFlight = createInFlightDedup<string, unknown>()

const LINK_TEXT_KEYS = new Set(['description', 'deprecationReason', 'deprecateReason', 'portfolioNotice'])
const URL_KEYS = new Set(['url'])
const REGEX_KEYS = new Set(['symbolRegex', 'nameRegex'])
const MAX_REGEX_LEN = 512
const LOGO_FILENAME_KEYS = new Set(['logo'])
const SAFE_LOGO_FILENAME_RE = /^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp|gif)$/i
const MAX_STRING_LEN = 16_384
const MAX_ARRAY_LEN = 10_000
const MARKDOWN_LINK_INJECTION_RE = /\[[^\]]*\]\(https?:\/\/[^)]*"[^)]*\)/

const isSafeHttpUrl = (value: string): boolean => {
  if (!value) return true
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

export function validateNode(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    if (node.length > MAX_ARRAY_LEN) {
      throw new Error(`Array too large at ${path}: ${node.length} exceeds ${MAX_ARRAY_LEN}`)
    }
    node.forEach((item, index) => validateNode(item, `${path}[${index}]`))
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_LEN) {
        throw new Error(`String too long at ${path}.${key}: ${value.length} exceeds ${MAX_STRING_LEN}`)
      }
      if (URL_KEYS.has(key) && !isSafeHttpUrl(value)) {
        throw new Error(`Unsafe URL in ${path}.${key}: protocol must be http or https`)
      }
      if (LOGO_FILENAME_KEYS.has(key) && value !== '' && !SAFE_LOGO_FILENAME_RE.test(value)) {
        throw new Error(`Unsafe logo filename in ${path}.${key}: ${value}`)
      }
      if (LINK_TEXT_KEYS.has(key) && MARKDOWN_LINK_INJECTION_RE.test(value)) {
        throw new Error(`Injection pattern detected in ${path}.${key}`)
      }
      if (REGEX_KEYS.has(key)) {
        if (value.length > MAX_REGEX_LEN) {
          throw new Error(`Invalid regex in ${path}.${key}: pattern exceeds ${MAX_REGEX_LEN} chars`)
        }
        try {
          new RegExp(value)
        }
        catch {
          throw new Error(`Invalid regex in ${path}.${key}: ${value}`)
        }
      }
    }
    else if (value !== null && typeof value === 'object') {
      validateNode(value, `${path}.${key}`)
    }
  }
}

const fallbackForAbsent = (key: string, file: LabelFile): unknown => {
  const stale = cache.getStale(key)
  if (stale !== undefined) return stale
  const empty = EMPTY_SHAPES[file]
  cache.set(key, empty)
  return empty
}

export function refreshLabelFile(scope: LabelScope, file: LabelFile): Promise<unknown> {
  const key = `${scope}:${file}`
  return inFlight.run(key, async () => {
    const statusKey = `${file}:${scope}`
    try {
      const response = await fetchWithTimeout(resolveLabelsFileUrl(scope, file))
      if (!response.ok) {
        if (response.status === 404 || response.status === 403) {
          reportStatus('labels-policy', statusKey, `absent-${response.status}`)
          return fallbackForAbsent(key, file)
        }
        throw new Error(`${file} effective-policy source returned ${response.status} for scope ${scope}`)
      }

      const data: unknown = await response.json()
      validateNode(data, file)
      cache.set(key, data)
      reportStatus('labels-policy', statusKey, 'ok')
      return data
    }
    catch (error) {
      reportStatus(
        'labels-policy',
        statusKey,
        'fetch-error',
        `Failed to fetch effective policy ${file} for scope ${scope}: ${error instanceof Error ? error.message : error}`,
      )
      const stale = cache.getStale(key)
      if (stale !== undefined) return stale
      throw error
    }
  })
}

export async function getLabelFile(scope: LabelScope, file: LabelFile): Promise<unknown> {
  const hit = cache.get(`${scope}:${file}`)
  return hit !== undefined ? hit : refreshLabelFile(scope, file)
}

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((entry): entry is string => typeof entry === 'string')
  return result.length > 0 ? result : undefined
}

const normalizeAddress = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  try {
    return getAddress(value)
  }
  catch {
    return undefined
  }
}

const addressArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const result = value.map(normalizeAddress).filter((entry): entry is string => Boolean(entry))
  return result.length > 0 ? result : undefined
}

const projectProductPolicies = (value: unknown): EffectiveLabelsSource['products'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: EffectiveLabelsSource['products'] = {}
  for (const [productId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const product = raw as Record<string, unknown>
    const vaultOverrides: NonNullable<EffectiveLabelsSource['products'][string]['vaultOverrides']> = {}
    if (product.vaultOverrides && typeof product.vaultOverrides === 'object' && !Array.isArray(product.vaultOverrides)) {
      for (const [address, rawOverride] of Object.entries(product.vaultOverrides as Record<string, unknown>)) {
        const normalizedAddress = normalizeAddress(address)
        if (!normalizedAddress) continue
        if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) continue
        const override = rawOverride as Record<string, unknown>
        vaultOverrides[normalizedAddress] = {
          ...(stringArray(override.block) && { block: stringArray(override.block) }),
          ...(stringArray(override.restricted) && { restricted: stringArray(override.restricted) }),
          ...(typeof override.notExplorableLend === 'boolean' && { notExplorableLend: override.notExplorableLend }),
          ...(typeof override.notExplorableBorrow === 'boolean' && { notExplorableBorrow: override.notExplorableBorrow }),
        }
      }
    }
    result[productId] = {
      ...(stringArray(product.block) && { block: stringArray(product.block) }),
      ...(stringArray(product.restricted) && { restricted: stringArray(product.restricted) }),
      ...(typeof product.notExplorable === 'boolean' && { notExplorable: product.notExplorable }),
      ...(addressArray(product.vaults) && { vaults: addressArray(product.vaults) }),
      ...(addressArray(product.deprecatedVaults) && { deprecatedVaults: addressArray(product.deprecatedVaults) }),
      ...(Object.keys(vaultOverrides).length > 0 && { vaultOverrides }),
    }
  }
  return result
}

const projectEarnPolicies = (value: unknown): EffectiveLabelsSource['earnVaults'] => {
  if (!Array.isArray(value)) return []
  const result: EffectiveLabelsSource['earnVaults'] = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      const address = normalizeAddress(raw)
      if (address) result.push(address)
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const address = normalizeAddress(entry.address)
    if (!address) continue
    result.push({
      address,
      ...(stringArray(entry.block) && { block: stringArray(entry.block) }),
      ...(stringArray(entry.restricted) && { restricted: stringArray(entry.restricted) }),
      ...(typeof entry.notExplorable === 'boolean' && { notExplorable: entry.notExplorable }),
    })
  }
  return result
}

const projectAssetPolicies = (value: unknown): EulerLabelAssetEntry[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const entry = raw as Record<string, unknown>
    const address = normalizeAddress(entry.address)
    const projected = {
      ...(address && { address }),
      ...(stringArray(entry.symbols) && { symbols: stringArray(entry.symbols) }),
      ...(typeof entry.symbolRegex === 'string' && { symbolRegex: entry.symbolRegex }),
      ...(stringArray(entry.names) && { names: stringArray(entry.names) }),
      ...(typeof entry.nameRegex === 'string' && { nameRegex: entry.nameRegex }),
      ...(stringArray(entry.block) && { block: stringArray(entry.block) }),
      ...(stringArray(entry.restricted) && { restricted: stringArray(entry.restricted) }),
    } as EulerLabelAssetEntry
    return 'address' in projected
      || 'symbols' in projected
      || 'symbolRegex' in projected
      || 'names' in projected
      || 'nameRegex' in projected
      ? [projected]
      : []
  })
}

export function projectEffectiveLabelsSource(
  products: unknown,
  earnVaults: unknown,
  assets: unknown,
): EffectiveLabelsSource {
  return {
    products: projectProductPolicies(products),
    earnVaults: projectEarnPolicies(earnVaults),
    assets: projectAssetPolicies(assets),
  }
}

export async function getEffectiveLabelsSource(chainId: number): Promise<EffectiveLabelsSource> {
  const [products, earnVaults, chainAssets, globalAssets] = await Promise.all([
    getLabelFile(chainId, 'products.json'),
    getLabelFile(chainId, 'earn-vaults.json'),
    getLabelFile(chainId, 'assets.json'),
    getLabelFile('all', 'assets.json'),
  ])
  return projectEffectiveLabelsSource(products, earnVaults, [
    ...(Array.isArray(chainAssets) ? chainAssets : []),
    ...(Array.isArray(globalAssets) ? globalAssets : []),
  ])
}
