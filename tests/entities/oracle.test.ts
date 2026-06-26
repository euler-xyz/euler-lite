import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  getRouterRecognition,
  resolveOracleAdapterIdentity,
  type OracleAdapterMeta,
} from '~/entities/oracle'

const oracle = '0x0000000000000000000000000000000000000001' as Address

const makeMeta = (overrides: Partial<OracleAdapterMeta> = {}): OracleAdapterMeta => ({
  oracle,
  ...overrides,
})

describe('resolveOracleAdapterIdentity', () => {
  it('uses curated name/provider for a recognised adapter', () => {
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
    // A curated entry exists, so it is recognised — not a custom adapter.
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
    const recognised = new Set([router])
    expect(getRouterRecognition([], recognised)).toBeNull()
    expect(getRouterRecognition([undefined, null], recognised)).toBeNull()
  })

  it('returns "recognised" when every router is in the allowlist', () => {
    const recognised = new Set([router, otherRouter])
    expect(getRouterRecognition([router, otherRouter], recognised)).toBe('recognised')
  })

  it('matches addresses case-insensitively', () => {
    const recognised = new Set([router])
    expect(getRouterRecognition([router.toUpperCase()], recognised)).toBe('recognised')
  })

  it('ignores nullish entries when classifying', () => {
    const recognised = new Set([router])
    expect(getRouterRecognition([undefined, router, null], recognised)).toBe('recognised')
  })

  it('returns "unrecognised" when any router is missing from the allowlist', () => {
    const recognised = new Set([router])
    expect(getRouterRecognition([router, otherRouter], recognised)).toBe('unrecognised')
  })
})
