import type { MarketGroupMetrics } from '~/entities/lend-discovery'

// A partly priced market's USD totals are only a lower bound, so a USD filter
// cannot judge them and must keep the market.
export const marketUsdMetricValue = (metrics: MarketGroupMetrics, metric: string): number | undefined => {
  if (!metrics.allVaultsPriced) return undefined
  const value = metrics[metric as keyof MarketGroupMetrics]
  return typeof value === 'number' ? value : undefined
}
