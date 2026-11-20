import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultType } from '@eulerxyz/euler-v2-sdk'
import { formatDepositShare, formatUncoveredBorrows, useVaultCheckWeights } from '~/composables/useVaultCheckWeights'
import type { VaultBadDebtCacheEntry } from '~/utils/vault-bad-debt'
import { formatCompactUsdValue } from '~/utils/string-utils'

const EARN = '0x3b4802fdb0e5d74aa37d58fd77d63e93d4f9a4af'
const EVK = '0x2a356443fee07703266066c6bb1b11b82d8246ad'
const STRATEGY = '0x6fe7fa90756434645f0b0428fdff78e99dda0fbc'
const PRIME = '0x797dd80692c3b2dadabce8e30c07fde5307d48a9'
const COLLATERAL = '0x55f9bace2c864ac0d3392ea9fa654b605f21a3d3'

const isLoaded = ref(true)
let openInterest: Record<string, Record<string, number>>
let borrowVaults: Record<string, { type: VaultType, address: string, totalBorrowed: bigint }>
let strategyAllocation: bigint
let badDebt: Record<string, Partial<VaultBadDebtCacheEntry>>
let primeAllocation: bigint

beforeEach(() => {
  isLoaded.value = true
  badDebt = {}
  strategyAllocation = 2_334n
  primeAllocation = 36_675n
  openInterest = {
    [EVK]: { [COLLATERAL]: 1500 },
    [STRATEGY]: { [COLLATERAL]: 200 },
    [PRIME]: { [COLLATERAL]: 300 },
  }
  borrowVaults = Object.fromEntries([EVK, STRATEGY, PRIME, COLLATERAL].map(address => [address, {
    type: VaultType.EVault, address, totalBorrowed: address === COLLATERAL ? 0n : 1_000n,
  }]))
  vi.stubGlobal('useVaultRegistry', () => ({
    get: (address: string) => ({
      [EARN]: { vault: { type: VaultType.EulerEarn, address: EARN, strategies: [
        { address: STRATEGY, allocatedAssets: strategyAllocation },
        { address: PRIME, allocatedAssets: primeAllocation },
        { address: COLLATERAL, allocatedAssets: 0n },
      ] } },
      ...Object.fromEntries(Object.entries(borrowVaults).map(([address, vault]) => [address, { vault }])),
    } as Record<string, unknown>)[address.toLowerCase()],
    registryVersion: ref(0),
  }))
  vi.stubGlobal('useCollateralOpenInterest', () => ({
    load: vi.fn(async () => {}),
    isLoaded,
    getOpenInterestForVault: (address: string) => openInterest[address.toLowerCase()] ?? {},
  }))
  vi.stubGlobal('useVaultBadDebt', () => ({
    getVaultBadDebt: (address: string) => badDebt[address.toLowerCase()],
    isBadDebtEnabled: ref(true),
    loadBadDebtForChain: vi.fn(),
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe('formatDepositShare', () => {
  it.each([[0.0598, '6%'], [0.004, '<1%'], [1, '100%'], [0, '0%']])('formats %s as %s', (share, text) => {
    expect(formatDepositShare(share)).toBe(text)
  })
})

describe('useVaultCheckWeights', () => {
  it('gives a strategy its share of the Earn vault\'s deposits', () => {
    const { weightOf } = useVaultCheckWeights(EARN)
    expect(weightOf({ namespace: 'strategy', address: STRATEGY })).toBe('Holds 6% of deposits')
    expect(weightOf({ namespace: 'strategy', address: COLLATERAL })).toBe('Holds none of the deposits')
    expect(weightOf({ namespace: 'strategy', address: '0x00000000000000000000000000000000000000ff' })).toBeNull()
  })

  it('labels a tiny positive strategy allocation as below 1%, while a zero allocation stays none', () => {
    strategyAllocation = 1_000_000n
    primeAllocation = 1_999_999_000_000n
    const { weightOf, weighAll } = useVaultCheckWeights(EARN)
    expect(weightOf({ namespace: 'strategy', address: STRATEGY })).toBe('Holds <1% of deposits')
    expect(weighAll([{ namespace: 'strategy', address: STRATEGY }])[0]?.value).toBeGreaterThan(0)
    expect(weightOf({ namespace: 'strategy', address: COLLATERAL })).toBe('Holds none of the deposits')
  })

  it('gives a collateral the borrows it covers, across the Earn vault\'s strategies', () => {
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL }))
      .toBe(`Covers ${formatCompactUsdValue(1500)} of borrows`)
    expect(useVaultCheckWeights(EARN).weightOf({ namespace: 'collateral', address: COLLATERAL }))
      .toBe(`Covers ${formatCompactUsdValue(500)} of borrows in this vault's strategies`)
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: STRATEGY })).toBe('Covers no borrows')
  })

  it('weighs a list of subjects, with the label and the number side by side', () => {
    const { weighAll } = useVaultCheckWeights(EARN)
    const [strategy, empty, collateral, none] = weighAll([
      { namespace: 'strategy', address: STRATEGY },
      { namespace: 'strategy', address: COLLATERAL },
      { namespace: 'collateral', address: COLLATERAL },
      undefined,
    ])
    expect(strategy).toEqual({ label: 'Holds 6% of deposits', scope: '', value: expect.closeTo(2_334 / 39_009, 6) })
    expect(empty).toEqual({ label: 'Holds none of the deposits', scope: '', value: 0 })
    expect(collateral).toEqual({ label: `Covers ${formatCompactUsdValue(500)} of borrows`, scope: ' in this vault\'s strategies', value: 500 })
    expect(none).toBeNull()
  })

  it('says nothing about borrows until open interest has loaded, or for a line with no subject', () => {
    isLoaded.value = false
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBeNull()
    expect(useVaultCheckWeights(EVK).weightOf(undefined)).toBeNull()
  })

  it.each([undefined, {}, { [COLLATERAL]: 0 }])('suppresses a missing utilized EVK split: %s', (split) => {
    if (split) openInterest[EVK] = split
    else Reflect.deleteProperty(openInterest, EVK)
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBeNull()
  })

  it('keeps known zero borrows distinct from missing exposure', () => {
    Reflect.deleteProperty(openInterest, EVK)
    borrowVaults[EVK].totalBorrowed = 0n
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBe('Covers no borrows')
  })

  it('suppresses partial Earn totals when a utilized strategy split is missing', () => {
    Reflect.deleteProperty(openInterest, STRATEGY)
    const { weightOf } = useVaultCheckWeights(EARN)
    expect(weightOf({ namespace: 'collateral', address: COLLATERAL })).toBeNull()
    expect(weightOf({ namespace: 'collateral', address: PRIME })).toBeNull()
    expect(weightOf({ namespace: 'strategy', address: STRATEGY })).toBe('Holds 6% of deposits')
  })

  it('can aggregate Earn exposure when the missing strategy split has known zero borrows', () => {
    Reflect.deleteProperty(openInterest, STRATEGY)
    borrowVaults[STRATEGY].totalBorrowed = 0n
    expect(useVaultCheckWeights(EARN).weightOf({ namespace: 'collateral', address: COLLATERAL }))
      .toBe(`Covers ${formatCompactUsdValue(300)} of borrows in this vault's strategies`)
  })

  it('does not assume an unresolved strategy with a missing split has zero borrows', () => {
    Reflect.deleteProperty(openInterest, STRATEGY)
    Reflect.deleteProperty(borrowVaults, STRATEGY)
    expect(useVaultCheckWeights(EARN).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBeNull()
  })

  it('says a sub-cent covered value is under a cent', () => {
    openInterest[EVK] = { [COLLATERAL]: 1.8771012270825452e-14, [STRATEGY]: 1.29 }
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBe('Covers <$0.01 of borrows')
  })
})

const unpriced = (usd: number, count: number) => ({ status: 'reported' as const, unpricedUsd: usd, unpricedCollateralCount: count })

describe('uncovered borrows', () => {
  it('states bad debt above the dust floor, with the part against unpriced collateral', () => {
    badDebt[EVK] = { badDebtUsd: 17_556.296, pricing: unpriced(3.6546, 1) }
    const uncovered = useVaultCheckWeights(EVK).getUncoveredBorrows()
    expect(uncovered).toEqual({ usd: 17_556.296, unpricedUsd: 3.6546, scope: '' })
    expect(formatUncoveredBorrows(uncovered!))
      .toBe('Uncovered: $17.56K of borrows are not covered by any collateral\'s current value; $3.65 of it against collateral without a usable price')
  })

  it('says all of it when every uncovered dollar sits against collateral without a usable price', () => {
    badDebt[EVK] = { badDebtUsd: 17_556.296, pricing: unpriced(17_556.296, 3) }
    expect(formatUncoveredBorrows(useVaultCheckWeights(EVK).getUncoveredBorrows()!))
      .toBe('Uncovered: $17.56K of borrows are not covered by any collateral\'s current value; all of it against collateral without a usable price')
  })

  it('leaves out the unpriced part when there is none or it is not reported', () => {
    badDebt[EVK] = { badDebtUsd: 20, pricing: unpriced(0, 0) }
    expect(formatUncoveredBorrows(useVaultCheckWeights(EVK).getUncoveredBorrows()!))
      .toBe('Uncovered: $20 of borrows are not covered by any collateral\'s current value')
    badDebt[EVK] = { badDebtUsd: 20, pricing: { status: 'not-reported' } }
    expect(useVaultCheckWeights(EVK).getUncoveredBorrows()).toEqual({ usd: 20, unpricedUsd: 0, scope: '' })
  })

  it.each([
    ['under $1', 0.99, 1500, false],
    ['at $1 on a small vault', 1, 1500, true],
    ['under 0.01% of a large vault\'s debt', 5, 10_000_000, false],
    ['above 0.01% of a large vault\'s debt', 1_500, 10_000_000, true],
  ])('applies the exposure display\'s dust floor: %s', (_label, usd, openInterestUsd, shown) => {
    openInterest[EVK] = { [COLLATERAL]: openInterestUsd }
    badDebt[EVK] = { badDebtUsd: usd, pricing: { status: 'not-reported' } }
    expect(useVaultCheckWeights(EVK).getUncoveredBorrows() !== null).toBe(shown)
  })

  it('says nothing until open interest has loaded', () => {
    badDebt[EVK] = { badDebtUsd: 17_556, pricing: { status: 'not-reported' } }
    isLoaded.value = false
    expect(useVaultCheckWeights(EVK).getUncoveredBorrows()).toBeNull()
  })

  it.each([['no open interest row', undefined], ['a zero row', { [COLLATERAL]: 0 }]])(
    'states V3\'s bad debt when no collateral covers any debt, a missing row counting as nothing covered: %s',
    (_label, split) => {
      if (split) openInterest[EVK] = split
      else Reflect.deleteProperty(openInterest, EVK)
      badDebt[EVK] = { badDebtUsd: 50_000, pricing: unpriced(50_000, 2) }
      expect(formatUncoveredBorrows(useVaultCheckWeights(EVK).getUncoveredBorrows()!))
        .toBe('Uncovered: $50K of borrows are not covered by any collateral\'s current value; all of it against collateral without a usable price')
    },
  )

  it('leaves out an Earn strategy the vault holds nothing in', () => {
    badDebt[COLLATERAL] = { badDebtUsd: 2_000_000, pricing: { status: 'not-reported' } }
    expect(useVaultCheckWeights(EARN).getUncoveredBorrows()).toBeNull()
  })

  it('adds up an Earn vault\'s strategies, each against its own floor, in the strategies\' scope', () => {
    badDebt[STRATEGY] = { badDebtUsd: 80, pricing: unpriced(5, 1) }
    badDebt[PRIME] = { badDebtUsd: 0.01, pricing: { status: 'not-reported' } }
    const uncovered = useVaultCheckWeights(EARN).getUncoveredBorrows()
    expect(uncovered).toEqual({ usd: 80, unpricedUsd: 5, scope: ' in this vault\'s strategies' })
    expect(formatUncoveredBorrows(uncovered!))
      .toBe('Uncovered: $80 of borrows in this vault\'s strategies are not covered by any collateral\'s current value; $5 of it against collateral without a usable price')
  })
})
