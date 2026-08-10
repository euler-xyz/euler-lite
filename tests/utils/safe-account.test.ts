import { describe, expect, it } from 'vitest'
import { getSafeSingletonVersion, resolveSafeAccountInfo } from '~/utils/safe-account'

const SAFE_141_SINGLETON = '0x41675C099F32341bf84BFc5382aF534df5C7461a'
const SAFE_130_L2_SINGLETON = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E'
const UNKNOWN_CONTRACT = '0x1111111111111111111111111111111111111111'

const OWNERS = [
  '0x00000000000000000000000000000000000000a1',
  '0x00000000000000000000000000000000000000a2',
  '0x00000000000000000000000000000000000000a3',
] as const

describe('getSafeSingletonVersion', () => {
  it('recognizes canonical singletons regardless of casing', () => {
    expect(getSafeSingletonVersion(SAFE_141_SINGLETON)).toBe('1.4.1')
    expect(getSafeSingletonVersion(SAFE_141_SINGLETON.toLowerCase())).toBe('1.4.1')
    expect(getSafeSingletonVersion(SAFE_130_L2_SINGLETON)).toBe('1.3.0')
  })

  it('rejects unknown addresses and empty input', () => {
    expect(getSafeSingletonVersion(UNKNOWN_CONTRACT)).toBeUndefined()
    expect(getSafeSingletonVersion(null)).toBeUndefined()
    expect(getSafeSingletonVersion(undefined)).toBeUndefined()
  })
})

describe('resolveSafeAccountInfo', () => {
  it('resolves a valid Safe configuration', () => {
    const info = resolveSafeAccountInfo(SAFE_141_SINGLETON, 2n, OWNERS)
    expect(info).toEqual({
      version: '1.4.1',
      threshold: 2,
      owners: OWNERS,
    })
  })

  it('rejects an unknown singleton even with plausible threshold/owners', () => {
    expect(resolveSafeAccountInfo(UNKNOWN_CONTRACT, 2n, OWNERS)).toBeNull()
  })

  it('rejects missing threshold or owners', () => {
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, null, OWNERS)).toBeNull()
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, 2n, null)).toBeNull()
  })

  it('rejects Safe-invariant violations from lookalikes', () => {
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, 0n, OWNERS)).toBeNull()
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, 4n, OWNERS)).toBeNull()
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, BigInt(Number.MAX_SAFE_INTEGER) + 1n, OWNERS)).toBeNull()
  })

  it('rejects owner lists a Safe cannot have', () => {
    const zeroOwner = '0x0000000000000000000000000000000000000000'
    const sentinelOwner = '0x0000000000000000000000000000000000000001'
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, 1n, [...OWNERS, zeroOwner])).toBeNull()
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, 1n, [...OWNERS, sentinelOwner])).toBeNull()
    expect(resolveSafeAccountInfo(SAFE_141_SINGLETON, 1n, [OWNERS[0], OWNERS[0].toUpperCase().replace('0X', '0x')])).toBeNull()
  })
})
