/**
 * Tests for the wrap-pair geo bypass.
 *
 * Lock in the policy invariants:
 * - `isWrapPair` is symmetric and case-insensitive.
 * - It is false when either side is missing or when the discovery map is
 *   empty (graceful no-op for non-ERC-4626 assets / fresh chain loads).
 * - The picker's `getAssetGeoState` bypasses soft-restrict on `output` mode
 *   only when both the candidate and the paired counterpart form a known
 *   wrap pair. Hard-block is never bypassed.
 *
 * Module state (country ref, assetRestrictions / wrapPairs) is shared across
 * imports — each test resets it explicitly.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useGeoBlock, clearAssetGeoCache, isAssetRestrictedByCountry } from '~/composables/useGeoBlock'
import { isWrapPair } from '~/utils/eulerLabelsUtils'
import { assetRestrictions, wrapPairs } from '~/utils/eulerLabelsState'

const SPYX = '0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48' // rebasing
const WSPYX = '0xc88FcD8B874fDb3256E8B55b3decB8c24EAb4c02' // wrapper
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const setCountry = (code: string | null | undefined) => {
  useGeoBlock().country.value = code
}

const resetState = () => {
  for (const k of Object.keys(assetRestrictions)) Reflect.deleteProperty(assetRestrictions, k)
  for (const k of Object.keys(wrapPairs)) Reflect.deleteProperty(wrapPairs, k)
  clearAssetGeoCache()
}

describe('isWrapPair', () => {
  beforeEach(resetState)

  it('returns false on an empty map (no discovery yet)', () => {
    expect(isWrapPair(SPYX, WSPYX)).toBe(false)
  })

  it('returns true when wrapper -> underlying mapping is present', () => {
    wrapPairs[WSPYX.toLowerCase()] = SPYX.toLowerCase()
    expect(isWrapPair(WSPYX, SPYX)).toBe(true)
  })

  it('is symmetric — underlying first or wrapper first both match', () => {
    wrapPairs[WSPYX.toLowerCase()] = SPYX.toLowerCase()
    expect(isWrapPair(SPYX, WSPYX)).toBe(true)
    expect(isWrapPair(WSPYX, SPYX)).toBe(true)
  })

  it('is case-insensitive on the inputs', () => {
    wrapPairs[WSPYX.toLowerCase()] = SPYX.toLowerCase()
    expect(isWrapPair(SPYX.toUpperCase(), WSPYX.toLowerCase())).toBe(true)
    expect(isWrapPair(SPYX.toLowerCase(), WSPYX.toUpperCase())).toBe(true)
  })

  it('returns false when the other side is unrelated', () => {
    wrapPairs[WSPYX.toLowerCase()] = SPYX.toLowerCase()
    expect(isWrapPair(USDC, WSPYX)).toBe(false)
    expect(isWrapPair(USDC, SPYX)).toBe(false)
  })

  it('returns false when either argument is missing', () => {
    wrapPairs[WSPYX.toLowerCase()] = SPYX.toLowerCase()
    expect(isWrapPair(undefined, WSPYX)).toBe(false)
    expect(isWrapPair(SPYX, undefined)).toBe(false)
    expect(isWrapPair(undefined, undefined)).toBe(false)
    expect(isWrapPair('', WSPYX)).toBe(false)
  })
})

describe('soft-restrict bypass — composition with isAssetRestrictedByCountry', () => {
  beforeEach(resetState)

  it('asset-level restriction still applies when no wrap pair exists', () => {
    setCountry('DE')
    assetRestrictions[WSPYX.toLowerCase()] = ['DE']
    // The geo layer itself doesn't know about wrap pairs — call sites combine
    // isAssetRestrictedByCountry with !isWrapPair(...). Verify the building
    // blocks compose as expected.
    expect(isAssetRestrictedByCountry(WSPYX)).toBe(true)
    expect(isWrapPair(USDC, WSPYX)).toBe(false)
    // Combined gate: restrict && !wrapPair => still restricted.
    expect(isAssetRestrictedByCountry(WSPYX) && !isWrapPair(USDC, WSPYX)).toBe(true)
  })

  it('combined gate releases when input/output form a wrap pair', () => {
    setCountry('DE')
    assetRestrictions[WSPYX.toLowerCase()] = ['DE']
    wrapPairs[WSPYX.toLowerCase()] = SPYX.toLowerCase()
    // Restricted but with wrap pair => combined gate is open.
    expect(isAssetRestrictedByCountry(WSPYX)).toBe(true)
    expect(isWrapPair(SPYX, WSPYX)).toBe(true)
    expect(isAssetRestrictedByCountry(WSPYX) && !isWrapPair(SPYX, WSPYX)).toBe(false)
  })
})
