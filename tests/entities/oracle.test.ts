import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  getRouterIndexStatus,
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

describe('getRouterIndexStatus (LITE-236)', () => {
  const router = '0xabc0000000000000000000000000000000000001'
  const otherRouter = '0xdef0000000000000000000000000000000000002'

  it('returns null when the allowlist is unavailable (empty set)', () => {
    expect(getRouterIndexStatus([router], new Set())).toBeNull()
  })

  it('returns null when there are no router addresses to check', () => {
    const recognized = new Set([router])
    expect(getRouterIndexStatus([], recognized)).toBeNull()
    expect(getRouterIndexStatus([undefined, null], recognized)).toBeNull()
  })

  it('returns "indexed" when every router is in the V3 router set', () => {
    const recognized = new Set([router, otherRouter])
    expect(getRouterIndexStatus([router, otherRouter], recognized)).toBe('indexed')
  })

  it('matches addresses case-insensitively', () => {
    const recognized = new Set([router])
    expect(getRouterIndexStatus([router.toUpperCase()], recognized)).toBe('indexed')
  })

  it('ignores nullish entries when classifying', () => {
    const recognized = new Set([router])
    expect(getRouterIndexStatus([undefined, router, null], recognized)).toBe('indexed')
  })

  it('returns "not-indexed" when any router is missing from the V3 set', () => {
    const recognized = new Set([router])
    expect(getRouterIndexStatus([router, otherRouter], recognized)).toBe('not-indexed')
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
