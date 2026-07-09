/**
 * Spec for the bigint-safe JSON wire codec used by the vault snapshot.
 *
 * Pins:
 *   - Round-trip equality for arbitrary nested shapes, including arrays.
 *   - Adversary-controlled strings (`__bi:0`, `__bi:deadbeef`) round-trip
 *     as plain strings, not as bigints.
 *   - Forged-tag shapes (extra keys, non-numeric payload) round-trip as
 *     plain objects.
 *   - Boundaries: 0n, uint256 max, negatives.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'
import { decodeBigints, encodeBigints } from '~/utils/snapshot-codec'

const ADDR = (suffix: string): Address => getAddress(`0x${suffix.padStart(40, '0')}`)
const HEX = (h: string): Hex => `0x${h}` as Hex

// Vault-shaped fixture: bigint-heavy, nested, adversarial strings.
const vaultInfoFixture = () => ({
  timestamp: 1_700_000_000n,
  vault: ADDR('111'),
  vaultName: 'Test eVault',
  vaultSymbol: 'eTEST',
  asset: ADDR('222'),
  totalShares: 12_345_678_901_234_567_890n,
  totalCash: 9_876_543_210_000_000_000n,
  totalBorrowed: 0n,
  accumulatedFees: 1_000n,
  irm: ADDR('444'),
  interestRate: 50_000_000_000_000n,
  collaterals: [
    {
      collateral: ADDR('aaa'),
      borrowLTV: 8_000n,
      liquidationLTV: 8_500n,
    },
  ],
  assetPriceInfo: {
    queryFailureReason: HEX('') as Hex,
    timestamp: 1_700_000_000n,
    amountIn: 1_000_000_000_000_000_000n,
    amountOutMid: 2_000_000_000_000_000_000n,
  },
})

describe('encodeBigints / decodeBigints', () => {
  it('replaces every bigint with a single-key { __bi: "<decimal>" } tag', () => {
    expect(encodeBigints({ a: 1n, nested: { b: -5n, arr: [42n, 'x'] } })).toEqual({
      a: { __bi: '1' },
      nested: { b: { __bi: '-5' }, arr: [{ __bi: '42' }, 'x'] },
    })
  })

  it('produces a tree JSON.stringify accepts (no raw bigints)', () => {
    const wire = encodeBigints(vaultInfoFixture())
    expect(() => JSON.stringify(wire)).not.toThrow()
    expect(JSON.stringify(wire)).toContain('"__bi"')
  })

  it('round-trips deep equal: decode(JSON.parse(JSON.stringify(encode(x)))) ≡ x', () => {
    const original = vaultInfoFixture()
    const wire = encodeBigints(original)
    const restored = decodeBigints(JSON.parse(JSON.stringify(wire)))
    expect(restored).toEqual(original)
  })

  it('preserves the maximum uint256 value as a bigint', () => {
    const huge = (1n << 256n) - 1n
    const restored = decodeBigints(JSON.parse(JSON.stringify(encodeBigints({ v: huge })))) as { v: bigint }
    expect(restored.v).toBe(huge)
    expect(typeof restored.v).toBe('bigint')
  })

  it('preserves zero as bigint 0n, not a missing field', () => {
    const restored = decodeBigints(JSON.parse(JSON.stringify(encodeBigints({ v: 0n })))) as { v: bigint }
    expect(restored.v).toBe(0n)
    expect(typeof restored.v).toBe('bigint')
  })

  it('preserves negative bigints (signed decimal wire)', () => {
    const restored = decodeBigints(
      JSON.parse(JSON.stringify(encodeBigints({ v: -1_234_567_890_123_456_789n }))),
    ) as { v: bigint }
    expect(restored.v).toBe(-1_234_567_890_123_456_789n)
  })

  it('leaves plain strings alone (including hex strings)', () => {
    const restored = decodeBigints(
      JSON.parse(JSON.stringify(encodeBigints({ hex: '0xdeadbeef', label: 'hello' }))),
    ) as { hex: string, label: string }
    expect(restored.hex).toBe('0xdeadbeef')
    expect(restored.label).toBe('hello')
  })

  it('walks arrays at the top level', () => {
    const restored = decodeBigints(
      JSON.parse(JSON.stringify(encodeBigints([1n, 2n, 'x']))),
    ) as Array<bigint | string>
    expect(restored).toEqual([1n, 2n, 'x'])
  })

  // === Adversary regressions ===

  it('treats adversarial string "__bi:0" as a plain string', () => {
    const restored = decodeBigints(
      JSON.parse(JSON.stringify(encodeBigints({ vaultName: '__bi:0', vaultSymbol: '__bi:deadbeef' }))),
    ) as { vaultName: string, vaultSymbol: string }
    expect(restored.vaultName).toBe('__bi:0')
    expect(restored.vaultSymbol).toBe('__bi:deadbeef')
  })

  it('treats a forged tag with extra keys as a plain object', () => {
    const restored = decodeBigints({ __bi: '1', extra: true }) as { __bi: string, extra: boolean }
    expect(restored).toEqual({ __bi: '1', extra: true })
    expect(typeof restored.__bi).toBe('string')
  })

  it('treats a forged tag with non-numeric payload as a plain object', () => {
    const restored = decodeBigints({ __bi: 'not-a-number' }) as { __bi: string }
    expect(restored).toEqual({ __bi: 'not-a-number' })
  })

  it('survives a realistic VaultInfoFull fixture (real-world coverage)', () => {
    const v = vaultInfoFixture()
    const restored = decodeBigints(JSON.parse(JSON.stringify(encodeBigints(v)))) as ReturnType<typeof vaultInfoFixture>
    expect(restored.timestamp).toBe(v.timestamp)
    expect(restored.totalShares).toBe(v.totalShares)
    expect(restored.collaterals[0].borrowLTV).toBe(v.collaterals[0].borrowLTV)
    expect(restored.assetPriceInfo.amountOutMid).toBe(v.assetPriceInfo.amountOutMid)
    expect(restored.vaultName).toBe(v.vaultName)
  })
})
