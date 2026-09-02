import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  formatOracleAssessmentReason,
  formatOracleCheckTitle,
  getOracleAssessmentState,
  getRouterRecognition,
  isOracleIdentityCheck,
  normalizeOracleAdapterCheckSeverity,
  resolveOracleAdapterIdentity,
  type OracleAdapterMeta,
  OracleAdapterCheckSeverity,
} from '~/entities/oracle'

const oracle = '0x0000000000000000000000000000000000000001' as Address

const makeMeta = (overrides: Partial<OracleAdapterMeta> = {}): OracleAdapterMeta => ({
  oracle,
  recognized: true,
  checksStatus: null,
  inActiveRoute: false,
  checks: [],
  ...overrides,
})

describe('resolveOracleAdapterIdentity', () => {
  it('uses curated name/provider for a recognized adapter', () => {
    const meta = makeMeta({ name: 'Chainlink WETH/USD', provider: 'Chainlink' })
    const identity = resolveOracleAdapterIdentity({ name: 'ChainlinkOracle' }, meta, true)

    expect(identity).toEqual({
      name: 'Chainlink WETH/USD',
      provider: 'Chainlink',
      isCustomAdapter: false,
    })
  })

  it('marks an adapter with no curated entry as custom and does NOT leak the onchain name (LITE-235)', () => {
    const identity = resolveOracleAdapterIdentity({ name: 'ChainlinkOracle' }, undefined, true)

    expect(identity.name).toBeUndefined()
    expect(identity.provider).toBeUndefined()
    expect(identity.isCustomAdapter).toBe(true)
  })

  it('does not fall back to the onchain name when the curated entry omits name/provider', () => {
    const meta = makeMeta({ methodology: 'Market price' })
    const identity = resolveOracleAdapterIdentity({ name: 'ChainlinkOracle' }, meta, true)

    expect(identity.name).toBeUndefined()
    expect(identity.provider).toBeUndefined()
    // A recognized assessment exists, so it is not a custom adapter.
    expect(identity.isCustomAdapter).toBe(false)
  })

  it('withholds self-reported identity when V3 assessed but did not recognize the adapter', () => {
    const meta = makeMeta({
      recognized: false,
      name: 'SpoofedOracle',
      provider: 'Spoofed provider',
    })
    const identity = resolveOracleAdapterIdentity({ name: 'SpoofedOracle' }, meta, true)

    expect(identity.name).toBeUndefined()
    expect(identity.provider).toBeUndefined()
    expect(identity.isCustomAdapter).toBe(true)
  })

  it('keeps the decoded name for non-adapter structural steps (e.g. ERC-4626 exchange rate)', () => {
    const identity = resolveOracleAdapterIdentity({ name: 'ERC4626Vault' }, undefined, false)

    expect(identity).toEqual({
      name: 'ERC4626Vault',
      provider: 'ERC4626Vault',
      isCustomAdapter: false,
    })
  })
})

describe('getRouterRecognition (LITE-236)', () => {
  const router = '0xabc0000000000000000000000000000000000001'
  const otherRouter = '0xdef0000000000000000000000000000000000002'

  it('returns null when the allowlist is unavailable (empty set)', () => {
    expect(getRouterRecognition([router], new Set())).toBeNull()
  })

  it('returns null when there are no router addresses to check', () => {
    const recognized = new Set([router])
    expect(getRouterRecognition([], recognized)).toBeNull()
    expect(getRouterRecognition([undefined, null], recognized)).toBeNull()
  })

  it('returns "recognized" when every router is in the recognized set', () => {
    const recognized = new Set([router, otherRouter])
    expect(getRouterRecognition([router, otherRouter], recognized)).toBe('recognized')
  })

  it('matches addresses case-insensitively', () => {
    const recognized = new Set([router])
    expect(getRouterRecognition([router.toUpperCase()], recognized)).toBe('recognized')
  })

  it('ignores nullish entries when classifying', () => {
    const recognized = new Set([router])
    expect(getRouterRecognition([undefined, router, null], recognized)).toBe('recognized')
  })

  it('returns "unrecognized" when any router is missing from the recognized set', () => {
    const recognized = new Set([router])
    expect(getRouterRecognition([router, otherRouter], recognized)).toBe('unrecognized')
  })
})

describe('normalizeOracleAdapterCheckSeverity', () => {
  it('accepts V3 severity casing', () => {
    expect(normalizeOracleAdapterCheckSeverity('High')).toBe(OracleAdapterCheckSeverity.High)
    expect(normalizeOracleAdapterCheckSeverity('Med')).toBe(OracleAdapterCheckSeverity.Medium)
    expect(normalizeOracleAdapterCheckSeverity('Info')).toBe(OracleAdapterCheckSeverity.Info)
  })

  it('keeps enum casing and falls back to info for unknown values', () => {
    expect(normalizeOracleAdapterCheckSeverity(OracleAdapterCheckSeverity.High)).toBe(OracleAdapterCheckSeverity.High)
    expect(normalizeOracleAdapterCheckSeverity('wat')).toBe(OracleAdapterCheckSeverity.Info)
    expect(normalizeOracleAdapterCheckSeverity(undefined)).toBe(OracleAdapterCheckSeverity.Info)
  })
})

describe('formatOracleCheckTitle', () => {
  it('turns a V3 rule key into a sentence-case title', () => {
    expect(formatOracleCheckTitle('quote-liveness')).toBe('Quote liveness')
    expect(formatOracleCheckTitle('source-provenance')).toBe('Source provenance')
    expect(formatOracleCheckTitle('cross-legs-recognized')).toBe('Cross legs recognized')
  })

  it('keeps proper nouns and acronyms cased', () => {
    expect(formatOracleCheckTitle('pyth-feed-recognized')).toBe('Pyth feed recognized')
    expect(formatOracleCheckTitle('linear-discount-pt-correspondence')).toBe('Linear discount PT correspondence')
    expect(formatOracleCheckTitle('xstocks-pause-config')).toBe('xStocks pause config')
    expect(formatOracleCheckTitle('chronicle-feed-recognized')).toBe('Chronicle feed recognized')
  })

  it('tolerates keys that are not kebab-case', () => {
    expect(formatOracleCheckTitle('Staleness')).toBe('Staleness')
    expect(formatOracleCheckTitle('')).toBe('')
  })
})

describe('formatOracleAssessmentReason', () => {
  it('re-titles the leading rule key', () => {
    expect(formatOracleAssessmentReason('source-provenance: Runtime bytecode does not match any known adapter build.'))
      .toBe('Source provenance: Runtime bytecode does not match any known adapter build.')
  })

  it('passes through reasons without a key prefix', () => {
    expect(formatOracleAssessmentReason('The adapter could not be recognized.')).toBe('The adapter could not be recognized.')
  })
})

describe('getOracleAssessmentState / isOracleIdentityCheck', () => {
  it('classifies absent, unrecognized and recognized assessments', () => {
    expect(getOracleAssessmentState(undefined)).toBe('unassessed')
    expect(getOracleAssessmentState(makeMeta({ recognized: false }))).toBe('unrecognized')
    expect(getOracleAssessmentState(makeMeta())).toBe('recognized')
  })

  it('only treats the three V3 recognition rules as identity checks', () => {
    expect(isOracleIdentityCheck({ id: 'adapter-exists' })).toBe(true)
    expect(isOracleIdentityCheck({ id: 'adapter-class-known' })).toBe(true)
    expect(isOracleIdentityCheck({ id: 'source-provenance' })).toBe(true)
    expect(isOracleIdentityCheck({ id: 'quote-liveness' })).toBe(false)
  })
})
