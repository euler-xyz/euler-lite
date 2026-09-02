import { decodeAbiParameters, type Address, type Hex, isHex, toHex, zeroAddress } from 'viem'
import {
  CROSS_ADAPTER_COMPONENTS,
  EULER_ROUTER_COMPONENTS,
  PYTH_ORACLE_COMPONENTS,
} from '~/entities/constants'

export type OracleDetailedInfo = {
  oracle: Address
  name: string
  oracleInfo: Hex
}

export type EulerRouterInfo = {
  governor: Address
  fallbackOracle: Address
  fallbackOracleInfo: OracleDetailedInfo
  bases: Address[]
  quotes: Address[]
  resolvedAssets: Address[][]
  resolvedOracles: Address[]
  resolvedOraclesInfo: OracleDetailedInfo[]
}

export type CrossAdapterInfo = {
  base: Address
  cross: Address
  quote: Address
  oracleBaseCross: Address
  oracleCrossQuote: Address
  oracleBaseCrossInfo: OracleDetailedInfo
  oracleCrossQuoteInfo: OracleDetailedInfo
}

export type PythOracleInfo = {
  pyth: Address
  base: Address
  quote: Address
  feedId: Hex
  maxStaleness: bigint
  maxConfWidth: bigint
}

export type PythFeed = {
  pythAddress: Address
  feedId: Hex
}

export type OracleAdapterEntry = {
  oracle: Address
  name: string
  base: Address
  quote: Address
}

export enum OracleAdapterCheckSeverity {
  High = 'HIGH',
  Medium = 'MEDIUM',
  Low = 'LOW',
  Info = 'INFO',
}

export enum OracleAdapterCheckOutcome {
  Pass = 'pass',
  Fail = 'fail',
  Unknown = 'unknown',
  NotApplicable = 'not_applicable',
}

export type OracleAdapterCheck = {
  id: string
  message: string
  outcome: OracleAdapterCheckOutcome
  severity: OracleAdapterCheckSeverity
  expected?: unknown
  observed?: unknown
}

export type OracleAdapterMeta = {
  oracle: Address
  base?: Address
  quote?: Address
  name?: string
  provider?: string
  methodology?: string
  label?: string
  model?: string
  recognized: boolean
  checksStatus: 'positive' | 'warning' | 'negative' | null
  reason?: string
  inActiveRoute: boolean
  checks: OracleAdapterCheck[]
  summary?: {
    passed: number
    failed: number
    unknown: number
    notApplicable: number
  }
  policyId?: string
  policyVersion?: number
  blockNumber?: string
  evaluatedAt?: string
  lastCheckedAt?: string
}

export function normalizeOracleAdapterCheckSeverity(severity: unknown): OracleAdapterCheckSeverity {
  if (typeof severity !== 'string') return OracleAdapterCheckSeverity.Info

  switch (severity.trim().toLowerCase()) {
    case 'high':
      return OracleAdapterCheckSeverity.High
    case 'med':
    case 'medium':
      return OracleAdapterCheckSeverity.Medium
    case 'low':
      return OracleAdapterCheckSeverity.Low
    case 'info':
      return OracleAdapterCheckSeverity.Info
    default:
      return OracleAdapterCheckSeverity.Info
  }
}

// Three-way assessment state of an adapter step. 'recognized': identity proven
// by V3, health verdict applies. 'unrecognized': V3 assessed the contract but
// could not identify it (unknown bytecode or class). 'unassessed': V3 has no
// row for it at all.
export type OracleAssessmentState = 'recognized' | 'unrecognized' | 'unassessed'

export function getOracleAssessmentState(meta: OracleAdapterMeta | undefined): OracleAssessmentState {
  if (!meta) return 'unassessed'
  return meta.recognized ? 'recognized' : 'unrecognized'
}

// Recognition (identity) rule keys, mirroring Data V3's RECOGNITION_RULE_KEYS
// plus the custom-adapter adjudication rule (policy v4): when an adjudicated
// custom adapter's deployed bytecode stops matching the pinned fingerprint,
// the high-severity mismatch finding is the actual explanation of the
// unrecognized verdict and must not be filtered out of the modal.
// These findings are the policy's own bytecode/provenance evaluation and are
// safe to show for unrecognized adapters; every other finding of an
// unrecognized adapter was read through getters recognition refused to trust
// and is withheld.
export const ORACLE_IDENTITY_CHECK_KEYS: ReadonlySet<string> = new Set([
  'adapter-exists',
  'adapter-class-known',
  'source-provenance',
  'custom-adapter-adjudicated',
])

export const isOracleIdentityCheck = (check: Pick<OracleAdapterCheck, 'id'>): boolean =>
  ORACLE_IDENTITY_CHECK_KEYS.has(check.id)

// Words in V3 rule keys that keep their own casing inside a sentence-case title.
const CHECK_TITLE_WORDS: Record<string, string> = {
  chronicle: 'Chronicle',
  lido: 'Lido',
  pendle: 'Pendle',
  pt: 'PT',
  pyth: 'Pyth',
  xstocks: 'xStocks',
}

// Turns a V3 rule key (`pyth-feed-recognized`) into a display title
// ("Pyth feed recognized"). Keys are stable machine identifiers; deriving the
// title here lets a new V3 rule render readably without a Lite release.
export function formatOracleCheckTitle(key: string): string {
  return key
    .split('-')
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase()
      if (Object.hasOwn(CHECK_TITLE_WORDS, lower)) return CHECK_TITLE_WORDS[lower]
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

// V3 formats `reason` as "<rule-key>: <description>". Re-title the key so the
// line reads like the check list ("Source provenance: Runtime bytecode …").
export function formatOracleAssessmentReason(reason: string): string {
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*): (.+)$/s.exec(reason)
  if (!match) return reason
  return `${formatOracleCheckTitle(match[1])}: ${match[2]}`
}

export type OracleAdapterIdentity = {
  name?: string
  provider?: string
  // True when Data V3 does not recognize the adapter's identity. This includes
  // adapters with no assessment and assessed contracts whose provenance could
  // not be established.
  isCustomAdapter: boolean
}

// Resolves the display name/provider for an oracle route step.
//
// An adapter step (`isAdapter`) only gets a name/provider from a recognized V3
// assessment. When recognition fails or the assessment is absent we must NOT
// fall back to the self-reported onchain `name()` — that value is
// attacker-controllable and would let an unknown adapter masquerade as a
// recognized one. Such steps are flagged as custom adapters and rendered as
// "Unknown".
//
// Structural steps (e.g. ERC-4626 exchange-rate `vault` steps) are not adapters and
// keep their decoded name, since it is derived from the route, not self-reported.
export function resolveOracleAdapterIdentity(
  step: { name: string },
  meta: OracleAdapterMeta | undefined,
  isAdapter: boolean,
): OracleAdapterIdentity {
  const fallback = isAdapter ? undefined : step.name
  const recognizedMeta = meta?.recognized ? meta : undefined
  return {
    name: recognizedMeta?.name || fallback,
    provider: recognizedMeta?.provider || fallback,
    isCustomAdapter: isAdapter && !recognizedMeta,
  }
}

// Classifies a vault's oracle router(s) against the recognized-router set.
// Data V3's `/v3/oracles/routers` is built from indexed `EulerRouterFactory`
// deployments, so every router it lists was deployed by the recognized factory
// — the same set the legacy oracle-checks `routers/all.json` was generated
// from. Membership is therefore a provenance verdict, not a "seen by the
// indexer" signal. Returns null — i.e. show nothing — when the set is
// unavailable (empty) or there are no routers to check, so a missing dataset
// never produces a false "unrecognized" warning.
export function getRouterRecognition(
  routerAddresses: ReadonlyArray<string | undefined | null>,
  recognized: ReadonlySet<string>,
): 'recognized' | 'unrecognized' | null {
  if (!recognized.size) return null
  const addresses = routerAddresses
    .filter((address): address is string => typeof address === 'string' && address.length > 0)
    .map(address => address.toLowerCase())
  if (!addresses.length) return null
  return addresses.every(address => recognized.has(address)) ? 'recognized' : 'unrecognized'
}

type OracleAdapterOptions = {
  base?: Address
  quote?: Address
  leafOnly?: boolean
  skipERC4626Bases?: Set<string>
}

export const isERC4626Oracle = (
  resolvedAssets: Address[] | undefined,
): boolean => {
  return Array.isArray(resolvedAssets) && resolvedAssets.length > 0
}

const normalizeHex = (value: Hex | string | Uint8Array): Hex => {
  if (typeof value === 'string') {
    return (isHex(value) ? value : `0x${value}`) as Hex
  }
  return toHex(value)
}

export const decodeEulerRouterInfo = (oracleInfo: Hex | string | Uint8Array): EulerRouterInfo | null => {
  try {
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: EULER_ROUTER_COMPONENTS }],
      normalizeHex(oracleInfo),
    )
    return decoded as EulerRouterInfo
  }
  catch {
    return null
  }
}

export const getEulerRouterGovernor = (
  oracleInfo: OracleDetailedInfo | null | undefined,
): Address | null => {
  if (!oracleInfo || oracleInfo.name !== 'EulerRouter') return null
  const decoded = decodeEulerRouterInfo(oracleInfo.oracleInfo)
  return decoded?.governor ?? null
}

export const decodeCrossAdapterInfo = (oracleInfo: Hex | string | Uint8Array): CrossAdapterInfo | null => {
  try {
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: CROSS_ADAPTER_COMPONENTS }],
      normalizeHex(oracleInfo),
    )
    return decoded as CrossAdapterInfo
  }
  catch {
    return null
  }
}

export const decodePythOracleInfo = (oracleInfo: Hex | string | Uint8Array): PythOracleInfo | null => {
  try {
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: PYTH_ORACLE_COMPONENTS }],
      normalizeHex(oracleInfo),
    )
    return decoded as PythOracleInfo
  }
  catch {
    return null
  }
}

export const collectPythFeedIds = (
  oracleInfo: OracleDetailedInfo | null | undefined,
  maxDepth = 3,
): PythFeed[] => {
  const feeds: PythFeed[] = []
  const visited = new Set<string>()

  const visit = (info: OracleDetailedInfo | null | undefined, depth: number) => {
    if (!info || depth > maxDepth) return
    const key = `${info.oracle}-${info.name}-${info.oracleInfo}`
    if (visited.has(key)) return
    visited.add(key)

    if (info.name === 'PythOracle') {
      const decoded = decodePythOracleInfo(info.oracleInfo)
      if (decoded) {
        feeds.push({
          pythAddress: decoded.pyth,
          feedId: normalizeHex(decoded.feedId),
        })
      }
      return
    }

    if (info.name === 'EulerRouter') {
      const decoded = decodeEulerRouterInfo(info.oracleInfo)
      if (!decoded) return
      visit(decoded.fallbackOracleInfo, depth + 1)
      decoded.resolvedOraclesInfo?.forEach((child) => {
        visit(child, depth + 1)
      })
      return
    }

    if (info.name === 'CrossAdapter') {
      const decoded = decodeCrossAdapterInfo(info.oracleInfo)
      if (!decoded) return
      visit(decoded.oracleBaseCrossInfo, depth + 1)
      visit(decoded.oracleCrossQuoteInfo, depth + 1)
      return
    }
  }

  visit(oracleInfo, 0)

  const deduped = new Map<string, PythFeed>()
  feeds.forEach((feed) => {
    const key = `${feed.pythAddress.toLowerCase()}:${feed.feedId.toLowerCase()}`
    if (!deduped.has(key)) {
      deduped.set(key, feed)
    }
  })

  return [...deduped.values()]
}

const resolveERC4626Base = (
  resolvedAssets: Address[] | undefined,
  base: Address | undefined,
): { effectiveBase: Address, wrapper: Address, underlying: Address } | null => {
  if (!resolvedAssets || !base || !isERC4626Oracle(resolvedAssets)) return null
  const wrapper = (resolvedAssets.length >= 2 ? resolvedAssets[0] : base) as Address
  const underlying = (resolvedAssets.length >= 2 ? resolvedAssets[1] : resolvedAssets[0]) as Address
  return { effectiveBase: underlying, wrapper, underlying }
}

type OracleAdapterContext = {
  base?: Address
  quote?: Address
}

const resolveAdapterPair = (context: OracleAdapterContext, override?: OracleAdapterContext) => {
  const base = override?.base ?? context.base
  const quote = override?.quote ?? context.quote
  if (!base || !quote) return null
  return { base, quote }
}

export const collectPythFeedIdsForPair = (
  oracleInfo: OracleDetailedInfo | null | undefined,
  base: Address,
  quote: Address,
  maxDepth = 3,
): PythFeed[] => {
  const feeds: PythFeed[] = []
  const visited = new Set<string>()

  const visit = (info: OracleDetailedInfo | null | undefined, depth: number, context: OracleAdapterContext) => {
    if (!info || depth > maxDepth) return
    const key = `${info.oracle}-${info.name}-${info.oracleInfo}-${context.base || ''}-${context.quote || ''}`
    if (visited.has(key)) return
    visited.add(key)

    if (info.name === 'EulerRouter') {
      const decoded = decodeEulerRouterInfo(info.oracleInfo)
      if (!decoded) return
      const targetBase = context.base?.toLowerCase()
      const targetQuote = context.quote?.toLowerCase()
      let matched = false
      const total = Math.max(
        decoded.resolvedOraclesInfo?.length ?? 0,
        decoded.bases?.length ?? 0,
        decoded.quotes?.length ?? 0,
      )
      for (let i = 0; i < total; i += 1) {
        const child = decoded.resolvedOraclesInfo?.[i]
        const childBase = decoded.bases?.[i]
        const childQuote = decoded.quotes?.[i]
        if (!child) continue
        if (targetBase && targetQuote) {
          if (!childBase || !childQuote) continue
          if (childBase.toLowerCase() !== targetBase || childQuote.toLowerCase() !== targetQuote) continue
          matched = true
        }
        const erc4626 = resolveERC4626Base(decoded.resolvedAssets?.[i], childBase)
        const effectiveBase = erc4626?.effectiveBase ?? childBase
        visit(child, depth + 1, { base: effectiveBase, quote: childQuote })
      }
      if (decoded.fallbackOracleInfo && (!targetBase || !targetQuote || !matched)) {
        visit(decoded.fallbackOracleInfo, depth + 1, context)
      }
      return
    }

    if (info.name === 'CrossAdapter') {
      const decoded = decodeCrossAdapterInfo(info.oracleInfo)
      if (!decoded) return
      visit(decoded.oracleBaseCrossInfo, depth + 1, { base: decoded.base, quote: decoded.cross })
      visit(decoded.oracleCrossQuoteInfo, depth + 1, { base: decoded.cross, quote: decoded.quote })
      return
    }

    if (info.name === 'PythOracle') {
      const decoded = decodePythOracleInfo(info.oracleInfo)
      const pair = resolveAdapterPair(context, decoded ? { base: decoded.base, quote: decoded.quote } : undefined)
      if (decoded && pair) {
        feeds.push({
          pythAddress: decoded.pyth,
          feedId: normalizeHex(decoded.feedId),
        })
      }
    }
  }

  visit(oracleInfo, 0, { base, quote })

  const deduped = new Map<string, PythFeed>()
  feeds.forEach((feed) => {
    const key = `${feed.pythAddress.toLowerCase()}:${feed.feedId.toLowerCase()}`
    if (!deduped.has(key)) {
      deduped.set(key, feed)
    }
  })

  return [...deduped.values()]
}

export const collectOracleAdapters = (
  oracleInfo: OracleDetailedInfo | null | undefined,
  maxDepth = 3,
  options: OracleAdapterOptions = {},
): OracleAdapterEntry[] => {
  const adapters: OracleAdapterEntry[] = []
  const visited = new Set<string>()
  const leafOnly = options.leafOnly ?? false

  const addAdapter = (info: OracleDetailedInfo, base: Address, quote: Address) => {
    if (info.oracle === zeroAddress) return
    if (base.toLowerCase() === quote.toLowerCase()) return
    adapters.push({ oracle: info.oracle, name: info.name, base, quote })
  }

  const visit = (info: OracleDetailedInfo | null | undefined, depth: number, context: OracleAdapterContext) => {
    if (!info || depth > maxDepth) return
    const key = `${info.oracle}-${info.name}-${info.oracleInfo}-${context.base || ''}-${context.quote || ''}`
    if (visited.has(key)) return
    visited.add(key)

    if (info.name === 'EulerRouter') {
      const decoded = decodeEulerRouterInfo(info.oracleInfo)
      if (!decoded) return
      const targetBase = context.base?.toLowerCase()
      const targetQuote = context.quote?.toLowerCase()
      let matched = false
      const total = Math.max(
        decoded.resolvedOraclesInfo?.length ?? 0,
        decoded.bases?.length ?? 0,
        decoded.quotes?.length ?? 0,
      )
      for (let i = 0; i < total; i += 1) {
        const child = decoded.resolvedOraclesInfo?.[i]
        const base = decoded.bases?.[i]
        const quote = decoded.quotes?.[i]
        if (!child) continue

        if (targetBase && targetQuote) {
          if (!base || !quote) continue
          if (base.toLowerCase() !== targetBase || quote.toLowerCase() !== targetQuote) continue
          matched = true
        }

        // ERC4626 resolution: resolvedAssets encodes the unwrap chain
        // Length 1: [underlying] — wrapper is decoded.bases[i]
        // Length 2: [wrapper, underlying] — wrapper is resolvedAssets[0]
        const erc4626 = resolveERC4626Base(decoded.resolvedAssets?.[i], base)

        if (erc4626) {
          if (!options.skipERC4626Bases?.has(erc4626.wrapper.toLowerCase())) {
            addAdapter(
              { oracle: erc4626.wrapper, name: 'ERC4626Vault', oracleInfo: '0x' as Hex },
              erc4626.wrapper,
              erc4626.underlying,
            )
          }
        }

        const effectiveBase = erc4626?.effectiveBase ?? base
        visit(child, depth + 1, { base: effectiveBase, quote })
      }
      if (decoded.fallbackOracleInfo && (!targetBase || !targetQuote || !matched)) {
        visit(decoded.fallbackOracleInfo, depth + 1, context)
      }
      return
    }

    if (info.name === 'CrossAdapter') {
      const decoded = decodeCrossAdapterInfo(info.oracleInfo)
      if (!decoded) return
      if (!leafOnly) {
        addAdapter(info, decoded.base, decoded.quote)
      }
      visit(decoded.oracleBaseCrossInfo, depth + 1, { base: decoded.base, quote: decoded.cross })
      visit(decoded.oracleCrossQuoteInfo, depth + 1, { base: decoded.cross, quote: decoded.quote })
      return
    }

    if (info.name === 'PythOracle') {
      const decoded = decodePythOracleInfo(info.oracleInfo)
      const pair = resolveAdapterPair(context, decoded ? { base: decoded.base, quote: decoded.quote } : undefined)
      if (pair) {
        addAdapter(info, pair.base, pair.quote)
      }
      return
    }

    const pair = resolveAdapterPair(context)
    if (pair) {
      addAdapter(info, pair.base, pair.quote)
    }
  }

  visit(oracleInfo, 0, { base: options.base, quote: options.quote })

  const deduped = new Map<string, OracleAdapterEntry>()
  adapters.forEach((adapter) => {
    const key = `${adapter.oracle.toLowerCase()}:${adapter.base.toLowerCase()}:${adapter.quote.toLowerCase()}`
    if (!deduped.has(key)) {
      deduped.set(key, adapter)
    }
  })

  return [...deduped.values()]
}

const isChainlinkOracleName = (name: string) => name.toLowerCase().includes('chainlink')

export const collectChainlinkOracles = (
  oracleInfo: OracleDetailedInfo | null | undefined,
  maxDepth = 3,
): Address[] => {
  const oracles: Address[] = []
  const visited = new Set<string>()

  const visit = (info: OracleDetailedInfo | null | undefined, depth: number) => {
    if (!info || depth > maxDepth) return
    const key = `${info.oracle}-${info.name}-${info.oracleInfo}`
    if (visited.has(key)) return
    visited.add(key)

    if (isChainlinkOracleName(info.name)) {
      oracles.push(info.oracle)
      return
    }

    if (info.name === 'EulerRouter') {
      const decoded = decodeEulerRouterInfo(info.oracleInfo)
      if (!decoded) return
      visit(decoded.fallbackOracleInfo, depth + 1)
      decoded.resolvedOraclesInfo?.forEach(child => visit(child, depth + 1))
      return
    }

    if (info.name === 'CrossAdapter') {
      const decoded = decodeCrossAdapterInfo(info.oracleInfo)
      if (!decoded) return
      visit(decoded.oracleBaseCrossInfo, depth + 1)
      visit(decoded.oracleCrossQuoteInfo, depth + 1)
    }
  }

  visit(oracleInfo, 0)

  const deduped = new Map<string, Address>()
  oracles.forEach((oracle) => {
    const key = oracle.toLowerCase()
    if (!deduped.has(key)) {
      deduped.set(key, oracle)
    }
  })

  return [...deduped.values()]
}
