import { describe, expect, it, vi } from 'vitest'
import type { MarketGroup } from '~/entities/lend-discovery'

const USD_PRICE_BY_VAULT = new Map<string, number>([
  ['0x0000000000000000000000000000000000004001', 2],
  ['0x0000000000000000000000000000000000004002', 2],
])

const usdValue = (amount: bigint, vault: { address: string }) => {
  const price = USD_PRICE_BY_VAULT.get(vault.address)
  return price === undefined ? undefined : Number(amount) * price
}

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValueOrZero: vi.fn(async (amount: bigint, vault: { address: string }) => usdValue(amount, vault) ?? 0),
  getAssetUsdValueForEstimate: vi.fn(async (amount: bigint, vault: { address: string }) => {
    if (amount === 0n) return 0
    const value = usdValue(amount, vault)
    return value !== undefined && value > 0 ? value : undefined
  }),
}))

const { resolveGroupTVL } = await import('~/composables/useMarketGroups')

const vault = (address: string, totalAssets: bigint, totalBorrowed = 0n) => ({
  type: 'EVault',
  address,
  isBorrowable: true,
  totalAssets,
  totalBorrowed,
  asset: { symbol: 'USDC' },
})

const group = (vaults: ReturnType<typeof vault>[]) =>
  ({ id: 'market', vaults, metrics: {} }) as unknown as MarketGroup

describe('resolveGroupTVL', () => {
  it('counts an empty vault as priced so it does not mark the market partial', async () => {
    const resolved = await resolveGroupTVL(group([
      vault('0x0000000000000000000000000000000000004001', 100n, 40n),
      vault('0x0000000000000000000000000000000000004003', 0n),
    ]))

    expect(resolved.metrics.allVaultsPriced).toBe(true)
    expect(resolved.metrics.pricedVaultCount).toBe(2)
    expect(resolved.metrics.totalTVL).toBe(200)
    expect(resolved.metrics.totalBorrowed).toBe(80)
  })

  it('marks the market partially priced when a vault with assets has no price', async () => {
    const resolved = await resolveGroupTVL(group([
      vault('0x0000000000000000000000000000000000004001', 100n),
      vault('0x0000000000000000000000000000000000004003', 50n),
    ]))

    expect(resolved.metrics.allVaultsPriced).toBe(false)
    expect(resolved.metrics.pricedVaultCount).toBe(1)
    expect(resolved.metrics.totalTVL).toBe(200)
  })
})
