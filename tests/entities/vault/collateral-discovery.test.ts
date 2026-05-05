import { describe, it, expect } from 'vitest'
import { extractUnresolvedCollateralAddresses } from '~/entities/vault/collateral-discovery'
import type { EVault, EVaultCollateral } from '~/entities/vault/types'

const ADDR_A = '0x000000000000000000000000000000000000c0a1'
const ADDR_B = '0x000000000000000000000000000000000000c0a2'
const ZERO = '0x0000000000000000000000000000000000000000'

const makeLtv = (overrides: Partial<any> = {}): EVaultCollateral => ({
  address: ADDR_A,
  borrowLTV: 0.75,
  liquidationLTV: 0.8,
  currentLiquidationLTV: 0.8,
  isLiquidationLTVRamping: false,
  rampTimeRemaining: 0n,
  oraclePriceRaw: {
    amountIn: 0n,
    amountOutMid: 0n,
    amountOutBid: 0n,
    amountOutAsk: 0n,
    timestamp: 0,
  },
  ...overrides,
}) as unknown as EVaultCollateral

const makeVault = (collaterals: EVaultCollateral[]): EVault =>
  ({ collaterals }) as unknown as EVault

const inRegistry = (...addrs: string[]) => {
  const set = new Set(addrs.map(a => a.toLowerCase()))
  return (addr: string) => set.has(addr.toLowerCase())
}

const lower = (xs: string[]) => xs.map(x => x.toLowerCase()).sort()

describe('extractUnresolvedCollateralAddresses', () => {
  it('returns addresses referenced as live collateral but not in the registry', () => {
    const vault = makeVault([
      makeLtv({ address: ADDR_A }),
      makeLtv({ address: ADDR_B }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false)
    expect(lower(result)).toEqual([ADDR_A, ADDR_B].map(a => a.toLowerCase()).sort())
  })

  it('skips collaterals already present in the registry', () => {
    const vault = makeVault([
      makeLtv({ address: ADDR_A }),
      makeLtv({ address: ADDR_B }),
    ])
    const result = extractUnresolvedCollateralAddresses(
      [vault],
      inRegistry(ADDR_A),
    )
    expect(lower(result)).toEqual([ADDR_B.toLowerCase()])
  })

  it('skips fully ramped-out edges (no need to fetch a collateral the UI will hide)', () => {
    const vault = makeVault([
      makeLtv({
        address: ADDR_A,
        borrowLTV: 0,
        liquidationLTV: 0,
        currentLiquidationLTV: 0,
      }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false)
    expect(result).toEqual([])
  })

  it('keeps mid-ramp edges (borrowLTV=0, liquidation LTV still > 0)', () => {
    const vault = makeVault([
      makeLtv({
        address: ADDR_A,
        borrowLTV: 0,
        liquidationLTV: 0, // target 0
        currentLiquidationLTV: 0.45,
        isLiquidationLTVRamping: true,
        rampTimeRemaining: 500n,
      }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false)
    expect(lower(result)).toEqual([ADDR_A.toLowerCase()])
  })

  it('skips the zero address', () => {
    const vault = makeVault([
      makeLtv({ address: ZERO }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false)
    expect(result).toEqual([])
  })

  it('deduplicates collaterals shared across multiple vaults', () => {
    const upperA = `0x${ADDR_A.slice(2).toUpperCase()}`
    const a = makeVault([makeLtv({ address: ADDR_A })])
    const b = makeVault([makeLtv({ address: upperA })])
    const result = extractUnresolvedCollateralAddresses([a, b], () => false)
    expect(lower(result)).toEqual([ADDR_A.toLowerCase()])
  })

  it('treats registry membership case-insensitively', () => {
    const upperA = `0x${ADDR_A.slice(2).toUpperCase()}`
    const vault = makeVault([makeLtv({ address: upperA })])
    const result = extractUnresolvedCollateralAddresses(
      [vault],
      inRegistry(ADDR_A),
    )
    expect(result).toEqual([])
  })

  it('keeps only edges that the SDK marks live', () => {
    const vault = makeVault([
      makeLtv({
        address: ADDR_A,
        borrowLTV: 0,
        liquidationLTV: 0,
        currentLiquidationLTV: 0,
      }),
      makeLtv({
        address: ADDR_B,
        borrowLTV: 0,
        liquidationLTV: 0,
        currentLiquidationLTV: 0.1,
      }),
    ])
    const result = extractUnresolvedCollateralAddresses([vault], () => false)
    expect(lower(result)).toEqual([ADDR_B.toLowerCase()])
  })
})
