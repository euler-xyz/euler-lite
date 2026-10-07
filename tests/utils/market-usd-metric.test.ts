import { describe, expect, it } from 'vitest'
import { marketUsdMetricValue } from '~/utils/market-usd-metric'
import type { MarketGroupMetrics } from '~/entities/lend-discovery'

const metrics = (overrides: Partial<MarketGroupMetrics> = {}) => ({
  totalTVL: 5_000,
  totalBorrowed: 1_000,
  totalAvailableLiquidity: 4_000,
  allVaultsPriced: true,
  pricedVaultCount: 2,
  vaultCount: 2,
  ...overrides,
}) as MarketGroupMetrics

describe('marketUsdMetricValue', () => {
  it('returns the market USD total when every vault is priced', () => {
    expect(marketUsdMetricValue(metrics(), 'totalTVL')).toBe(5_000)
    expect(marketUsdMetricValue(metrics(), 'totalAvailableLiquidity')).toBe(4_000)
  })

  it('reports no value for a partly priced market, so USD filters keep it', () => {
    expect(marketUsdMetricValue(metrics({ allVaultsPriced: false, pricedVaultCount: 1 }), 'totalTVL')).toBeUndefined()
  })

  it('reports no value for a metric that is not a number', () => {
    expect(marketUsdMetricValue(metrics(), 'assetSymbols')).toBeUndefined()
  })
})
