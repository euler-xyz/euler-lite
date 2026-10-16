import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultType } from '@eulerxyz/euler-v2-sdk'
import { formatDepositShare, useVaultCheckWeights } from '~/composables/useVaultCheckWeights'
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
let primeAllocation: bigint

beforeEach(() => {
  isLoaded.value = true
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

  it('gives a collateral the borrows it backs, across the Earn vault\'s strategies', () => {
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL }))
      .toBe(`Backs ${formatCompactUsdValue(1500)} of borrows`)
    expect(useVaultCheckWeights(EARN).weightOf({ namespace: 'collateral', address: COLLATERAL }))
      .toBe(`Backs ${formatCompactUsdValue(500)} of borrows in this vault's strategies`)
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: STRATEGY })).toBe('Backs no borrows')
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
    expect(collateral).toEqual({ label: `Backs ${formatCompactUsdValue(500)} of borrows`, scope: ' in this vault\'s strategies', value: 500 })
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
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBe('Backs no borrows')
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
      .toBe(`Backs ${formatCompactUsdValue(300)} of borrows in this vault's strategies`)
  })

  it('does not assume an unresolved strategy with a missing split has zero borrows', () => {
    Reflect.deleteProperty(openInterest, STRATEGY)
    Reflect.deleteProperty(borrowVaults, STRATEGY)
    expect(useVaultCheckWeights(EARN).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBeNull()
  })
})
