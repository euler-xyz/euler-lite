/**
 * Tests for the geo-blocking policy layer introduced by the asset-level
 * assets.json support (PR #302).
 *
 * These lock in the policy invariants, not implementation details:
 *
 * - "Country unknown = treat as restricted" — absence of signal is a deny.
 * - "Sanctioned country = hard block, always." — no per-asset opt-out possible.
 * - "Asset-level rules OR vault-level rules" — asset-level is a floor.
 * - "Pattern rules are only consulted when symbol/name are known." — pure-address
 *   callers (legacy) keep their pre-PR behavior.
 * - "Regex patterns never scan unbounded input." — MAX_REGEX_INPUT_LEN ReDoS guard.
 * - "Cache can't serve a decision against rules that have been cleared."
 *
 * The country ref and current SDK labels snapshot are shared across imports —
 * each test resets them explicitly in beforeEach.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EulerLabelAssetPatternRule } from '@eulerxyz/euler-v2-sdk'
import {
  useGeoBlock,
  clearAssetGeoCache,
  isAssetBlockedByCountry,
  isAssetRestrictedByCountry,
  isVaultBlockedByCountry,
  isVaultRestrictedByCountry,
} from '~/composables/useGeoBlock'
import { __setEulerLabelsDataForTest, getCurrentEulerLabelsData } from '~/composables/useEulerLabels'

// Mock the vault registry before the module under test imports it.
// The registry is consulted by isVaultBlockedByCountry / isVaultRestrictedByCountry
// to resolve the underlying asset so asset-level rules OR into the vault decision.
// `vi.mock` is hoisted above imports by the Vitest transform, so the order here
// is safe despite the linter preferring imports-at-top.
const getVaultMock = vi.fn<(addr: string) => { asset?: { address: string, symbol: string, name: string } } | undefined>()
vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({ getVault: getVaultMock }),
}))

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

const labelState = () => getCurrentEulerLabelsData()
const assetBlocks = new Proxy({} as Record<string, string[]>, {
  get: (_, prop: string) => labelState().assetBlocks[prop],
  set: (_, prop: string, value: string[]) => {
    labelState().assetBlocks[prop] = value
    return true
  },
  deleteProperty: (_, prop: string) => Reflect.deleteProperty(labelState().assetBlocks, prop),
  ownKeys: () => Reflect.ownKeys(labelState().assetBlocks),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
})
const assetRestrictions = new Proxy({} as Record<string, string[]>, {
  get: (_, prop: string) => labelState().assetRestrictions[prop],
  set: (_, prop: string, value: string[]) => {
    labelState().assetRestrictions[prop] = value
    return true
  },
  deleteProperty: (_, prop: string) => Reflect.deleteProperty(labelState().assetRestrictions, prop),
  ownKeys: () => Reflect.ownKeys(labelState().assetRestrictions),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
})
const assetPatternRules = new Proxy([] as EulerLabelAssetPatternRule[], {
  get: (_, prop: string) => {
    const value = (labelState().assetPatternRules as unknown as Record<string, unknown>)[prop]
    return typeof value === 'function' ? value.bind(labelState().assetPatternRules) : value
  },
  set: (_, prop: string, value: EulerLabelAssetPatternRule | number) => {
    ;(labelState().assetPatternRules as unknown as Record<string, unknown>)[prop] = value
    return true
  },
})

const setCountry = (code: string | null | undefined) => {
  useGeoBlock().country.value = code
}

const resetState = () => {
  __setEulerLabelsDataForTest()
  clearAssetGeoCache()
  getVaultMock.mockReset()
}

describe('isAssetBlockedByCountry — loading & sentinel states', () => {
  beforeEach(resetState)

  it('returns false while the country is still loading (undefined)', () => {
    setCountry(undefined)
    // Even with a matching rule, a still-loading country is treated as "no decision yet"
    // so the UI doesn't flicker into a Restricted state on the first paint.
    assetBlocks[USDC.toLowerCase()] = ['DE']
    expect(isAssetBlockedByCountry(USDC)).toBe(false)
  })

  it('returns true once loading completes but country could not be detected (null)', () => {
    setCountry(null)
    // Unknown-country = deny: we prefer to over-block rather than leak exposure
    // when the geo signal has failed.
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
  })

  it('returns false for an empty asset reference', () => {
    setCountry('DE')
    expect(isAssetBlockedByCountry(undefined)).toBe(false)
    expect(isAssetBlockedByCountry('')).toBe(false)
    expect(isAssetBlockedByCountry({})).toBe(false)
  })
})

describe('isAssetBlockedByCountry — sanctioned countries', () => {
  beforeEach(resetState)

  it('hard-blocks every asset when the detected country is sanctioned', () => {
    setCountry('IR') // Iran — sanctioned, no per-asset rule needed
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
    expect(isAssetBlockedByCountry(WETH)).toBe(true)
    expect(isAssetBlockedByCountry({ symbol: 'RANDOM' })).toBe(true)
  })

  it('is case-insensitive on the detected country code', () => {
    setCountry('ir')
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
  })
})

describe('isAssetBlockedByCountry — address-keyed rules', () => {
  beforeEach(resetState)

  it('blocks an address listed in assetBlocks for the detected country', () => {
    setCountry('DE')
    assetBlocks[USDC.toLowerCase()] = ['DE']
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
  })

  it('does not block addresses that are not in the rule list', () => {
    setCountry('DE')
    assetBlocks[USDC.toLowerCase()] = ['DE']
    expect(isAssetBlockedByCountry(WETH)).toBe(false)
  })

  it('does not block when the user country is not in the block list', () => {
    setCountry('CA')
    assetBlocks[USDC.toLowerCase()] = ['DE', 'FR']
    expect(isAssetBlockedByCountry(USDC)).toBe(false)
  })

  it('accepts address keys in any case (normalized to lowercase internally)', () => {
    setCountry('DE')
    assetBlocks[USDC.toLowerCase()] = ['DE']
    expect(isAssetBlockedByCountry(USDC.toUpperCase())).toBe(true)
    expect(isAssetBlockedByCountry(USDC.toLowerCase())).toBe(true)
  })
})

describe('isAssetBlockedByCountry — COUNTRY_GROUPS expansion', () => {
  beforeEach(resetState)

  it('expands the EU alias to its member states', () => {
    setCountry('FR')
    assetBlocks[USDC.toLowerCase()] = ['EU']
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
  })

  it('expands EEA to include Iceland / Liechtenstein / Norway', () => {
    setCountry('IS')
    assetBlocks[USDC.toLowerCase()] = ['EEA']
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
  })

  it('keeps Switzerland out of EEA (EFTA-only)', () => {
    setCountry('CH')
    assetBlocks[USDC.toLowerCase()] = ['EEA']
    expect(isAssetBlockedByCountry(USDC)).toBe(false)
  })

  it('treats EFTA as the EFTA member states', () => {
    setCountry('CH')
    assetBlocks[USDC.toLowerCase()] = ['EFTA']
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
  })

  it('passes plain ISO codes through untouched', () => {
    setCountry('BR')
    assetBlocks[USDC.toLowerCase()] = ['BR']
    expect(isAssetBlockedByCountry(USDC)).toBe(true)
  })
})

describe('isAssetBlockedByCountry — pattern rules (symbols / names)', () => {
  beforeEach(resetState)

  it('matches by exact symbol (case-insensitive)', () => {
    setCountry('DE')
    assetPatternRules.push({
      symbolsLower: new Set(['usdy', 'ousg']),
      block: ['DE'],
    })
    expect(isAssetBlockedByCountry({ symbol: 'USDY', name: 'Ondo US Dollar Yield' })).toBe(true)
    expect(isAssetBlockedByCountry({ symbol: 'OUSG', name: 'Other' })).toBe(true)
    expect(isAssetBlockedByCountry({ symbol: 'UNRELATED', name: 'Other' })).toBe(false)
  })

  it('matches by symbol regex', () => {
    setCountry('DE')
    assetPatternRules.push({
      symbolRegex: /^ompl$/i,
      block: ['DE'],
    })
    expect(isAssetBlockedByCountry({ symbol: 'OMPL' })).toBe(true)
    expect(isAssetBlockedByCountry({ symbol: 'OMPL2' })).toBe(false)
  })

  it('matches by exact name (case-insensitive)', () => {
    setCountry('DE')
    assetPatternRules.push({
      namesLower: new Set(['ondo us dollar yield']),
      block: ['DE'],
    })
    expect(isAssetBlockedByCountry({ symbol: 'X', name: 'Ondo US Dollar Yield' })).toBe(true)
    expect(isAssetBlockedByCountry({ symbol: 'X', name: 'Ondo Other' })).toBe(false)
  })

  it('matches by name regex (e.g. issuer-wide rules)', () => {
    setCountry('DE')
    assetPatternRules.push({
      nameRegex: /^ondo\s/i,
      block: ['DE'],
    })
    expect(isAssetBlockedByCountry({ symbol: 'X', name: 'Ondo US Treasuries' })).toBe(true)
    expect(isAssetBlockedByCountry({ symbol: 'X', name: 'OndoCoin' })).toBe(false) // no space after "Ondo"
  })

  it('does not consult pattern rules when only an address is provided', () => {
    // Plain-address callers (legacy) skip pattern scanning — preserving pre-PR behavior
    // for call sites that don't yet pass the full asset object.
    setCountry('DE')
    assetPatternRules.push({
      symbolsLower: new Set(['usdy']),
      block: ['DE'],
    })
    expect(isAssetBlockedByCountry(USDC)).toBe(false)
  })

  it('treats inputs longer than 128 chars as a regex match (fail-closed ReDoS guard)', () => {
    // A curator-typo regex must never run .test() against an attacker-chosen
    // long on-chain symbol/name (real symbols are <=12 chars; names <=64). The
    // ReDoS guard still prevents .test() from running, but we fail closed:
    // an oversize input is treated as if it matched the regex, so an attacker
    // cannot bypass a geo rule by padding their token's symbol/name.
    setCountry('DE')
    assetPatternRules.push({
      symbolRegex: /^xx_no_match_xx$/i, // would NOT match the oversize input
      block: ['DE'],
    })
    const oversize = 'B'.repeat(129) // 129 chars → exceeds cap → counted as a match
    expect(isAssetBlockedByCountry({ symbol: oversize })).toBe(true)

    // A 128-char input (exactly at the cap) still runs through .test().
    const atLimit = 'B'.repeat(128) // 128 chars → does NOT match the regex
    expect(isAssetBlockedByCountry({ symbol: atLimit })).toBe(false)
  })

  it('ignores a pattern rule whose block list is empty', () => {
    // Empty-block rules exist for the restricted-only case; they must not
    // short-circuit the block decision.
    setCountry('DE')
    assetPatternRules.push({
      symbolsLower: new Set(['usdy']),
      block: [],
      restricted: ['DE'],
    })
    expect(isAssetBlockedByCountry({ symbol: 'USDY' })).toBe(false)
  })
})

describe('isAssetRestrictedByCountry', () => {
  beforeEach(resetState)

  it('consults the restricted address map', () => {
    setCountry('DE')
    assetRestrictions[WETH.toLowerCase()] = ['DE']
    expect(isAssetRestrictedByCountry(WETH)).toBe(true)
    expect(isAssetBlockedByCountry(WETH)).toBe(false)
  })

  it('consults pattern rules against the restricted list', () => {
    setCountry('DE')
    assetPatternRules.push({
      symbolsLower: new Set(['ompl']),
      restricted: ['DE'],
    })
    expect(isAssetRestrictedByCountry({ symbol: 'OMPL' })).toBe(true)
  })

  it('does not return true for sanctioned countries by itself', () => {
    // Sanctioned = hard block, not a soft restriction. isAssetRestrictedByCountry
    // stays honest: it only reports the "restricted" layer. The UI composes both.
    setCountry('IR')
    expect(isAssetRestrictedByCountry(WETH)).toBe(false)
  })
})

describe('clearAssetGeoCache', () => {
  beforeEach(resetState)

  it('drops cached decisions so removed rules stop taking effect', () => {
    setCountry('DE')
    assetBlocks[USDC.toLowerCase()] = ['DE']
    // Warm the cache with a true decision
    expect(isAssetBlockedByCountry(USDC)).toBe(true)

    // Remove the rule but do NOT clear — stale cache still says "blocked".
    Reflect.deleteProperty(assetBlocks, USDC.toLowerCase())
    expect(isAssetBlockedByCountry(USDC)).toBe(true) // cache hit

    clearAssetGeoCache()
    expect(isAssetBlockedByCountry(USDC)).toBe(false)
  })
})

describe('isVaultBlockedByCountry — asset-level OR', () => {
  beforeEach(resetState)

  it('blocks a vault whose underlying asset is address-blocked', () => {
    setCountry('DE')
    assetBlocks[USDC.toLowerCase()] = ['DE']
    const vault = '0x1111111111111111111111111111111111111111'
    getVaultMock.mockReturnValue({
      asset: { address: USDC, symbol: 'USDC', name: 'USD Coin' },
    })
    expect(isVaultBlockedByCountry(vault)).toBe(true)
  })

  it('blocks a vault whose underlying asset matches a pattern rule', () => {
    setCountry('DE')
    assetPatternRules.push({
      symbolsLower: new Set(['usdy']),
      block: ['DE'],
    })
    const vault = '0x2222222222222222222222222222222222222222'
    getVaultMock.mockReturnValue({
      asset: { address: '0xdeadbeef', symbol: 'USDY', name: 'Ondo US Dollar Yield' },
    })
    expect(isVaultBlockedByCountry(vault)).toBe(true)
  })

  it('does not block a vault whose registry lookup returns no asset', () => {
    setCountry('DE')
    assetBlocks['0xdeadbeef'] = ['DE']
    const vault = '0x3333333333333333333333333333333333333333'
    getVaultMock.mockReturnValue(undefined)
    expect(isVaultBlockedByCountry(vault)).toBe(false)
  })

  it('propagates sanctioned-country blocks even without any vault rule', () => {
    setCountry('KP') // North Korea — sanctioned
    getVaultMock.mockReturnValue(undefined)
    expect(isVaultBlockedByCountry('0x4444444444444444444444444444444444444444')).toBe(true)
  })
})

describe('isVaultRestrictedByCountry — asset-level OR', () => {
  beforeEach(resetState)

  it('restricts a vault whose underlying asset is soft-restricted by address', () => {
    setCountry('DE')
    assetRestrictions[WETH.toLowerCase()] = ['DE']
    const vault = '0x5555555555555555555555555555555555555555'
    getVaultMock.mockReturnValue({
      asset: { address: WETH, symbol: 'WETH', name: 'Wrapped Ether' },
    })
    expect(isVaultRestrictedByCountry(vault)).toBe(true)
  })

  it('restricts a vault whose underlying asset matches a restricted pattern rule', () => {
    setCountry('DE')
    assetPatternRules.push({
      symbolRegex: /^ompl$/i,
      restricted: ['DE'],
    })
    const vault = '0x6666666666666666666666666666666666666666'
    getVaultMock.mockReturnValue({
      asset: { address: '0xdeadbeef', symbol: 'OMPL', name: 'Ampleforth' },
    })
    expect(isVaultRestrictedByCountry(vault)).toBe(true)
  })
})
