import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import {
  buildDeprecatedEarnSet,
  buildEntityAddressSets,
  buildProductMaps,
  declaredKeysOf,
  tryChecksum,
} from '~/server/utils/labels-helpers'

const A = getAddress('0x1111111111111111111111111111111111111111')
const B = getAddress('0x2222222222222222222222222222222222222222')
const C = getAddress('0x3333333333333333333333333333333333333333')

describe('tryChecksum', () => {
  it('returns checksummed address for valid input', () => {
    expect(tryChecksum(A.toLowerCase())).toBe(A)
  })

  it('returns null for invalid input', () => {
    expect(tryChecksum('not an address')).toBe(null)
    expect(tryChecksum(undefined)).toBe(null)
    expect(tryChecksum(null)).toBe(null)
    expect(tryChecksum(42)).toBe(null)
  })
})

describe('declaredKeysOf', () => {
  it('returns array of strings unchanged', () => {
    expect(declaredKeysOf(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('wraps a single string in an array', () => {
    expect(declaredKeysOf('euler')).toEqual(['euler'])
  })

  it('filters non-string entries from arrays', () => {
    expect(declaredKeysOf(['a', 42, null, 'b'])).toEqual(['a', 'b'])
  })

  it('returns empty array for unsupported values', () => {
    expect(declaredKeysOf(undefined)).toEqual([])
    expect(declaredKeysOf({})).toEqual([])
  })
})

describe('buildProductMaps', () => {
  it('builds declared keys map for active vaults and deprecated vaults', () => {
    const products = {
      prime: { entity: 'euler', vaults: [A, B], deprecatedVaults: [C] },
    }
    const { declaredKeysByVault, deprecatedSet } = buildProductMaps(products)
    expect(declaredKeysByVault.get(A)).toEqual(['euler'])
    expect(declaredKeysByVault.get(B)).toEqual(['euler'])
    expect(declaredKeysByVault.get(C)).toEqual(['euler'])
    expect([...deprecatedSet]).toEqual([C])
  })

  it('normalizes lowercase input to checksum', () => {
    const products = {
      prime: { entity: ['e1', 'e2'], vaults: [A.toLowerCase()] },
    }
    const { declaredKeysByVault } = buildProductMaps(products)
    expect(declaredKeysByVault.get(A)).toEqual(['e1', 'e2'])
  })

  it('skips malformed addresses', () => {
    const products = {
      prime: { entity: 'euler', vaults: ['not an address', A] },
    }
    const { declaredKeysByVault } = buildProductMaps(products)
    expect(declaredKeysByVault.size).toBe(1)
    expect(declaredKeysByVault.get(A)).toEqual(['euler'])
  })
})

describe('buildDeprecatedEarnSet', () => {
  it('captures entries flagged deprecated: true', () => {
    const set = buildDeprecatedEarnSet([
      { address: A, deprecated: true },
      { address: B, deprecated: false },
      { address: C },
    ])
    expect([...set]).toEqual([A])
  })

  it('handles bare-string entries gracefully (legacy shape)', () => {
    const set = buildDeprecatedEarnSet([A, { address: B, deprecated: true }])
    expect([...set]).toEqual([B])
  })
})

describe('buildEntityAddressSets', () => {
  it('builds checksummed Sets per entity', () => {
    const entities = {
      euler: { addresses: { [A.toLowerCase()]: 'gov', [B]: 'admin' } },
      dao: { addresses: { [C]: 'multisig' } },
    }
    const map = buildEntityAddressSets(entities)
    expect(map.get('euler')?.has(A)).toBe(true)
    expect(map.get('euler')?.has(B)).toBe(true)
    expect(map.get('dao')?.has(C)).toBe(true)
    expect(map.get('dao')?.has(A)).toBe(false)
  })

  it('skips invalid address keys', () => {
    const entities = {
      euler: { addresses: { 'not-an-address': 'x', [A]: 'gov' } },
    }
    const map = buildEntityAddressSets(entities)
    expect(map.get('euler')?.size).toBe(1)
    expect(map.get('euler')?.has(A)).toBe(true)
  })

  it('returns empty Set for entities with missing addresses', () => {
    const map = buildEntityAddressSets({ euler: {} })
    expect(map.get('euler')?.size).toBe(0)
  })
})
