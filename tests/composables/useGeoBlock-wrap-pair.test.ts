/**
 * Tests for the ERC-4626 wrap-pair bypass on soft-restricted assets.
 *
 * Policy invariants locked in:
 * - `isWrapPair` is symmetric and case-insensitive.
 * - It is false when either side is missing or when the discovery map is
 *   empty (graceful no-op for non-ERC-4626 assets / fresh chain loads).
 * - `isAssetRestrictedByCountry(asset, { counterpart })` bypasses the
 *   soft-restrict gate when `asset` and `counterpart` form a known wrap
 *   pair. Hard-block is never bypassed (covered by useGeoBlock.test.ts).
 *
 * Module state (country ref, assetRestrictions / wrapPairs) is shared across
 * imports — each test resets it explicitly.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useGeoBlock, clearAssetGeoCache, isAssetRestrictedByCountry } from '~/composables/useGeoBlock'
import { isWrapPair } from '~/utils/eulerLabelsUtils'
import { assetRestrictions, wrapPairs } from '~/utils/eulerLabelsState'

// Synthetic addresses — the bypass logic doesn't care about real tokens.
const UNDERLYING = '0x0000000000000000000000000000000000000A11'
const WRAPPER = '0x0000000000000000000000000000000000000B22'
const UNRELATED = '0x0000000000000000000000000000000000000C33'

const setCountry = (code: string | null | undefined) => {
  useGeoBlock().country.value = code
}

const resetState = () => {
  setCountry(undefined)
  for (const k of Object.keys(assetRestrictions)) Reflect.deleteProperty(assetRestrictions, k)
  for (const k of Object.keys(wrapPairs)) Reflect.deleteProperty(wrapPairs, k)
  clearAssetGeoCache()
}

describe('isWrapPair', () => {
  beforeEach(resetState)

  it('returns false on an empty map (no discovery yet)', () => {
    expect(isWrapPair(UNDERLYING, WRAPPER)).toBe(false)
  })

  it('returns true when wrapper -> underlying mapping is present', () => {
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isWrapPair(WRAPPER, UNDERLYING)).toBe(true)
  })

  it('is symmetric — underlying first or wrapper first both match', () => {
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isWrapPair(UNDERLYING, WRAPPER)).toBe(true)
    expect(isWrapPair(WRAPPER, UNDERLYING)).toBe(true)
  })

  it('is case-insensitive on the inputs', () => {
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isWrapPair(UNDERLYING.toUpperCase(), WRAPPER.toLowerCase())).toBe(true)
    expect(isWrapPair(UNDERLYING.toLowerCase(), WRAPPER.toUpperCase())).toBe(true)
  })

  it('returns false when the other side is unrelated', () => {
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isWrapPair(UNRELATED, WRAPPER)).toBe(false)
    expect(isWrapPair(UNRELATED, UNDERLYING)).toBe(false)
  })

  it('returns false when either argument is missing', () => {
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isWrapPair(undefined, WRAPPER)).toBe(false)
    expect(isWrapPair(UNDERLYING, undefined)).toBe(false)
    expect(isWrapPair(undefined, undefined)).toBe(false)
    expect(isWrapPair('', WRAPPER)).toBe(false)
  })
})

describe('isAssetRestrictedByCountry — counterpart bypass', () => {
  beforeEach(resetState)

  it('still restricts when no counterpart is provided', () => {
    setCountry('DE')
    assetRestrictions[WRAPPER.toLowerCase()] = ['DE']
    expect(isAssetRestrictedByCountry(WRAPPER)).toBe(true)
  })

  it('still restricts when counterpart is unrelated', () => {
    setCountry('DE')
    assetRestrictions[WRAPPER.toLowerCase()] = ['DE']
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isAssetRestrictedByCountry(WRAPPER, { counterpart: UNRELATED })).toBe(true)
  })

  it('releases when counterpart is the asset’s underlying', () => {
    setCountry('DE')
    assetRestrictions[WRAPPER.toLowerCase()] = ['DE']
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isAssetRestrictedByCountry(WRAPPER, { counterpart: UNDERLYING })).toBe(false)
  })

  it('releases symmetrically when asset is the underlying and counterpart is the wrapper', () => {
    setCountry('DE')
    assetRestrictions[UNDERLYING.toLowerCase()] = ['DE']
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isAssetRestrictedByCountry(UNDERLYING, { counterpart: WRAPPER })).toBe(false)
  })

  it('does not release when asset is not actually restricted (counterpart no-op)', () => {
    setCountry('DE')
    wrapPairs[WRAPPER.toLowerCase()] = UNDERLYING.toLowerCase()
    expect(isAssetRestrictedByCountry(WRAPPER, { counterpart: UNDERLYING })).toBe(false)
  })

  it('releases when counterpart is the asset itself (identity — no swap)', () => {
    // Receiving the same asset you already hold (e.g. plain withdraw of a
    // vault's underlying) is not a new acquisition, identical reasoning to
    // the wrap-pair bypass. The wrapPairs map is left empty here to ensure
    // the release path is identity, not wrap-pair.
    setCountry('DE')
    assetRestrictions[WRAPPER.toLowerCase()] = ['DE']
    expect(isAssetRestrictedByCountry(WRAPPER, { counterpart: WRAPPER })).toBe(false)
  })

  it('identity bypass is case-insensitive', () => {
    setCountry('DE')
    assetRestrictions[WRAPPER.toLowerCase()] = ['DE']
    expect(isAssetRestrictedByCountry(WRAPPER.toLowerCase(), { counterpart: WRAPPER.toUpperCase() })).toBe(false)
  })
})
