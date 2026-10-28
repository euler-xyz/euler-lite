import { describe, expect, it } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { buildLendSwapProjectionPlan, resolveLendSwapProjectedRates } from '~/utils/lend-swap-apy'

const makeVault = (address: string) => ({
  address,
  totalCash: 1_000n,
  totalBorrowed: 400n,
}) as EVault

const source = makeVault('0x0000000000000000000000000000000000000001')
const target = makeVault('0x0000000000000000000000000000000000000002')
const sourceRates = { supplyAPY: 1n, borrowAPY: 2n }
const targetRates = { supplyAPY: 3n, borrowAPY: 4n }

describe('lend swap APY projection plan', () => {
  it('indexes source withdrawal and target deposit projections', () => {
    const plan = buildLendSwapProjectionPlan(source, target, 100n, 95n)

    expect(plan).toMatchObject({ sourceIndex: 0, targetIndex: 1 })
    expect(plan.requests).toEqual([
      expect.objectContaining({ vaultAddress: source.address, cashDelta: -100n }),
      expect.objectContaining({ vaultAddress: target.address, cashDelta: 95n }),
    ])
    expect(resolveLendSwapProjectedRates(plan, [sourceRates, targetRates])).toEqual({
      source: sourceRates,
      target: targetRates,
    })
  })

  it('uses a target-only projection for a non-EVault source', () => {
    const plan = buildLendSwapProjectionPlan(null, target, 100n, 95n)

    expect(plan).toMatchObject({ sourceIndex: null, targetIndex: 0 })
    expect(plan.requests).toEqual([
      expect.objectContaining({ vaultAddress: target.address, cashDelta: 95n }),
    ])
    expect(resolveLendSwapProjectedRates(plan, [targetRates])).toEqual({
      source: null,
      target: targetRates,
    })
  })

  it('fails closed on short or null projection results', () => {
    const plan = buildLendSwapProjectionPlan(source, target, 100n, 95n)

    expect(resolveLendSwapProjectedRates(plan, [sourceRates])).toBeNull()
    expect(resolveLendSwapProjectedRates(plan, [sourceRates, null])).toBeNull()
  })
})
