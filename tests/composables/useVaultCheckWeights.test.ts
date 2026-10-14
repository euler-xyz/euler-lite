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
const openInterest: Record<string, Record<string, number>> = {
  [EVK]: { [COLLATERAL]: 1500 },
  [STRATEGY]: { [COLLATERAL]: 200 },
  [PRIME]: { [COLLATERAL]: 300 },
}

beforeEach(() => {
  isLoaded.value = true
  vi.stubGlobal('useVaultRegistry', () => ({
    get: (address: string) => ({
      [EARN]: { vault: { type: VaultType.EulerEarn, address: EARN, strategies: [
        { address: STRATEGY, allocatedAssets: 2_334n },
        { address: PRIME, allocatedAssets: 36_675n },
        { address: COLLATERAL, allocatedAssets: 0n },
      ] } },
      [EVK]: { vault: { type: VaultType.EVault, address: EVK } },
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

  it('gives a collateral the borrows it backs, across the Earn vault\'s strategies', () => {
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL }))
      .toBe(`Backs ${formatCompactUsdValue(1500)} of borrows`)
    expect(useVaultCheckWeights(EARN).weightOf({ namespace: 'collateral', address: COLLATERAL }))
      .toBe(`Backs ${formatCompactUsdValue(500)} of borrows in this vault's strategies`)
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: STRATEGY })).toBe('Backs no borrows')
  })

  it('says nothing about borrows until open interest has loaded, or for a line with no subject', () => {
    isLoaded.value = false
    expect(useVaultCheckWeights(EVK).weightOf({ namespace: 'collateral', address: COLLATERAL })).toBeNull()
    expect(useVaultCheckWeights(EVK).weightOf(undefined)).toBeNull()
  })
})
