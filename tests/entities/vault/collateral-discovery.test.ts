import { describe, it, expect } from 'vitest'
import { extractUnresolvedCollateralAddresses } from '~/entities/vault/collateral-discovery'
import type { Vault, VaultCollateralLTV } from '~/entities/vault/types'

const NOW = 1500n

const ADDR_A = '0x000000000000000000000000000000000000c0a1'
const ADDR_B = '0x000000000000000000000000000000000000c0a2'
const ZERO = '0x0000000000000000000000000000000000000000'

const makeLtv = (overrides: Partial<VaultCollateralLTV> = {}): VaultCollateralLTV => ({
  collateral: ADDR_A,
  borrowLTV: 7500n,
  liquidationLTV: 8000n,
  initialLiquidationLTV: 9000n,
  targetTimestamp: 2000n,
  rampDuration: 1000n,
  ...overrides,
})

const makeVault = (collateralLTVs: VaultCollateralLTV[]): Vault =>
  ({ collateralLTVs }) as unknown as Vault

const inRegistry = (...addrs: string[]) => {
  const set = new Set(addrs.map(a => a.toLowerCase()))
  return (addr: string) => set.has(addr.toLowerCase())
}

const lower = (xs: string[]) => xs.map(x => x.toLowerCase()).sort()

describe('extractUnresolvedCollateralAddresses', () => {
  it('returns addresses referenced as live collateral but not in the registry', () => {
    const vault = makeVault([
      makeLtv({ collateral: ADDR_A }),
      makeLtv({ collateral: ADDR_B }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false, NOW)
    expect(lower(result)).toEqual([ADDR_A, ADDR_B].map(a => a.toLowerCase()).sort())
  })

  it('skips collaterals already present in the registry', () => {
    const vault = makeVault([
      makeLtv({ collateral: ADDR_A }),
      makeLtv({ collateral: ADDR_B }),
    ])
    const result = extractUnresolvedCollateralAddresses(
      [vault],
      inRegistry(ADDR_A),
      NOW,
    )
    expect(lower(result)).toEqual([ADDR_B.toLowerCase()])
  })

  it('skips fully ramped-out edges (no need to fetch a collateral the UI will hide)', () => {
    const vault = makeVault([
      makeLtv({
        collateral: ADDR_A,
        borrowLTV: 0n,
        liquidationLTV: 0n,
        initialLiquidationLTV: 9000n,
        targetTimestamp: 100n, // ramp completed before NOW=1500
        rampDuration: 50n,
      }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false, NOW)
    expect(result).toEqual([])
  })

  it('keeps mid-ramp edges (borrowLTV=0, liquidation LTV still > 0)', () => {
    const vault = makeVault([
      makeLtv({
        collateral: ADDR_A,
        borrowLTV: 0n,
        liquidationLTV: 0n, // target 0
        initialLiquidationLTV: 9000n,
        targetTimestamp: 2000n, // ramp not yet finished at NOW=1500
        rampDuration: 1000n,
      }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false, NOW)
    expect(lower(result)).toEqual([ADDR_A.toLowerCase()])
  })

  it('skips the zero address', () => {
    const vault = makeVault([
      makeLtv({ collateral: ZERO }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false, NOW)
    expect(result).toEqual([])
  })

  it('deduplicates collaterals shared across multiple vaults', () => {
    const upperA = `0x${ADDR_A.slice(2).toUpperCase()}`
    const a = makeVault([makeLtv({ collateral: ADDR_A })])
    const b = makeVault([makeLtv({ collateral: upperA })])
    const result = extractUnresolvedCollateralAddresses([a, b], () => false, NOW)
    expect(lower(result)).toEqual([ADDR_A.toLowerCase()])
  })

  it('treats registry membership case-insensitively', () => {
    const upperA = `0x${ADDR_A.slice(2).toUpperCase()}`
    const vault = makeVault([makeLtv({ collateral: upperA })])
    const result = extractUnresolvedCollateralAddresses(
      [vault],
      inRegistry(ADDR_A),
      NOW,
    )
    expect(result).toEqual([])
  })

  it('snapshots time once so mid-evaluation Date.now() jitter cannot move ramp boundaries', () => {
    // Edge with a borderline ramp: targetTimestamp exactly NOW means the ramp
    // is complete, edge is dead. If the helper called Date.now() per-edge
    // and the wall-clock advanced mid-loop the second edge could see now+ε
    // and still be dead — but we want a single snapshot.
    const vault = makeVault([
      makeLtv({
        collateral: ADDR_A,
        borrowLTV: 0n,
        liquidationLTV: 0n,
        initialLiquidationLTV: 9000n,
        targetTimestamp: NOW,
        rampDuration: 1000n,
      }),
      makeLtv({
        collateral: ADDR_B,
        borrowLTV: 0n,
        liquidationLTV: 0n,
        initialLiquidationLTV: 9000n,
        targetTimestamp: NOW + 100n,
        rampDuration: 1000n,
      }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false, NOW)
    // First edge dead at NOW; second still mid-ramp.
    expect(lower(result)).toEqual([ADDR_B.toLowerCase()])
  })
})
