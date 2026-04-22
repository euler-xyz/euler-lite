import { describe, expect, it } from 'vitest'
import { serialiseSnapshot, deserialiseSnapshot } from '~/entities/vault/loader-serde'
import type { ChainVaultsSnapshot } from '~/entities/vault/loader'

/**
 * The serde must survive every bigint-containing field the loader produces.
 * We construct a minimal-but-bigint-heavy snapshot and assert deep equality
 * after round-trip. JSON-stringify the encoded form to confirm no bigints
 * leak to the wire.
 */
describe('loader-serde', () => {
  const mockSnapshot = (): ChainVaultsSnapshot => ({
    chainId: 1,
    fetchedAt: 1_700_000_000_000,
    evkVaults: [
      {
        verified: true,
        address: '0xvault1',
        name: 'Test Vault',
        symbol: 'TV',
        decimals: 18n,
        supply: 1000000n,
        borrow: 500000n,
        supplyCap: 10_000_000_000_000_000_000_000n,
        borrowCap: 5_000_000_000_000_000_000_000n,
        totalCash: 500000n,
        totalAssets: 1000000n,
        totalShares: 1000000n,
        interestFee: 100n,
        configFlags: 0n,
        oracle: '0xoracle',
        collateralLTVs: [
          {
            collateral: '0xcol',
            borrowLTV: 8000n,
            liquidationLTV: 9000n,
            initialLiquidationLTV: 0n,
            targetTimestamp: 0n,
            rampDuration: 0n,
          },
        ],
        collateralPrices: [],
        liabilityPriceInfo: {
          amountIn: 1000000000000000000n,
          amountOutAsk: 1000000000000000000n,
          amountOutBid: 1000000000000000000n,
          amountOutMid: 1000000000000000000n,
          queryFailure: false,
          queryFailureReason: '',
          timestamp: 1700000000n,
          oracle: '0xoracle',
          asset: '0xasset',
          unitOfAccount: '0x0000000000000000000000000000000000000348',
        },
        maxLiquidationDiscount: 500n,
        interestRateInfo: {
          borrowAPY: 500_000_000_000_000_000_000_000n,
          borrowSPY: 1n,
          borrows: 500000n,
          cash: 500000n,
          supplyAPY: 300_000_000_000_000_000_000_000n,
        },
        asset: { address: '0xasset', name: 'Asset', symbol: 'AST', decimals: 18n },
        dToken: '0xdtoken',
        governorAdmin: '0xgov',
        governorFeeReceiver: '0xreceiver',
        unitOfAccount: '0xuoa',
        interestRateModelAddress: '0xirm',
        hookTarget: '0x0000000000000000000000000000000000000000',
        hookedOps: 0n,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test vault shape
    ] as any,
    earnVaults: [],
    securitizeVaults: [],
    escrowVaults: [],
  })

  it('round-trips a snapshot with bigint-heavy fields', () => {
    const snap = mockSnapshot()
    const wire = serialiseSnapshot(snap)
    const restored = deserialiseSnapshot(wire)
    expect(restored).toEqual(snap)
  })

  it('produces a wire representation that JSON.stringify accepts (no raw bigints)', () => {
    const snap = mockSnapshot()
    const wire = serialiseSnapshot(snap)
    expect(() => JSON.stringify(wire)).not.toThrow()
    expect(JSON.stringify(wire)).toContain('"__bi"')
  })

  it('restored bigint values survive JSON string round-trip', () => {
    const snap = mockSnapshot()
    const wire = serialiseSnapshot(snap)
    const restored = deserialiseSnapshot(JSON.parse(JSON.stringify(wire)))
    expect(restored.evkVaults[0].supply).toBe(snap.evkVaults[0].supply)
    expect(restored.evkVaults[0].supplyCap).toBe(snap.evkVaults[0].supplyCap)
    expect(restored.evkVaults[0].interestRateInfo.borrowAPY).toBe(snap.evkVaults[0].interestRateInfo.borrowAPY)
  })

  // Regression: vault name() / symbol() are adversary-controlled on-chain.
  // A naive prefix-on-string encoding would let a malicious vault with
  // `name = "__bi:0"` silently deserialise to the bigint 0n, corrupting
  // downstream string operations. The object-wrapper encoding prevents this.
  it('treats adversarial strings that look like the bigint tag as plain strings', () => {
    const snap = mockSnapshot()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(snap.evkVaults[0] as any).name = '__bi:0'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(snap.evkVaults[0] as any).symbol = '__bi:deadbeef'
    const restored = deserialiseSnapshot(JSON.parse(JSON.stringify(serialiseSnapshot(snap))))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((restored.evkVaults[0] as any).name).toBe('__bi:0')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((restored.evkVaults[0] as any).symbol).toBe('__bi:deadbeef')
  })
})
