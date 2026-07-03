import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  getChecksStatus,
  getRouterRecognition,
  normalizeOracleAdapterCheckSeverity,
  resolveOracleAdapterIdentity,
  type OracleAdapterMeta,
  OracleAdapterCheckSeverity,
} from '~/entities/oracle'

const oracle = '0x0000000000000000000000000000000000000001' as Address

const makeMeta = (overrides: Partial<OracleAdapterMeta> = {}): OracleAdapterMeta => ({
  oracle,
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
    // A curated entry exists, so it is recognized — not a custom adapter.
    expect(identity.isCustomAdapter).toBe(false)
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

  it('returns "recognized" when every router is in the allowlist', () => {
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

  it('returns "unrecognized" when any router is missing from the allowlist', () => {
    const recognized = new Set([router])
    expect(getRouterRecognition([router, otherRouter], recognized)).toBe('unrecognized')
  })
})

describe('normalizeOracleAdapterCheckSeverity', () => {
  it('accepts oracle-checks wire casing', () => {
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

describe('getChecksStatus', () => {
  it('treats normalized high-severity failures as negative', () => {
    expect(getChecksStatus([{
      id: 'Source code provenance',
      message: 'Contract metadata hash is not recognized.',
      pass: false,
      severity: normalizeOracleAdapterCheckSeverity('High'),
    }])).toBe('negative')
  })
})
