import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'

const CONCURRENCY = 10
const MATURITY_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000

type PendleSource = Extract<IntrinsicApySourceConfig, { provider: 'pendle' }>

type PendleMarketData = {
  impliedApy?: number
  timestamp?: string
}

const normalize = (value?: string) => value?.toLowerCase() || ''

const isMatured = (timestamp?: string): boolean => {
  if (!timestamp) return true
  const ts = new Date(timestamp).getTime()
  return Date.now() - ts > MATURITY_STALE_THRESHOLD_MS
}

const fetchMarketData = async (
  source: PendleSource,
): Promise<IntrinsicApyResult | undefined> => {
  const req = toIntrinsicApyRequest(source)
  try {
    const data = await $fetch<PendleMarketData>(req.path, { query: req.query })

    if (!data || isMatured(data.timestamp)) {
      return {
        address: normalize(source.address),
        info: { apy: 0, provider: 'Pendle' },
      }
    }

    const apy = (data.impliedApy ?? 0) * 100

    return {
      address: normalize(source.address),
      info: {
        apy,
        provider: 'Pendle',
        source: `https://app.pendle.finance/trade/markets`,
      },
    }
  }
  catch {
    return undefined
  }
}

const batchFetch = async (sources: PendleSource[]): Promise<IntrinsicApyResult[]> => {
  const results: IntrinsicApyResult[] = []

  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.allSettled(batch.map(fetchMarketData))

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value)
      }
    }
  }

  return results
}

export const createPendleProvider = (sources: readonly IntrinsicApySourceConfig[]): IntrinsicApyProvider => {
  const pendleSources = sources.filter(
    (s): s is PendleSource => s.provider === 'pendle',
  )

  return {
    name: 'Pendle',

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = pendleSources.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []
      return batchFetch(chainSources)
    },
  }
}
