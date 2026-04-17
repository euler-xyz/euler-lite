import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'
import { logWarn } from '~/utils/errorHandling'

type SecuritizeSource = Extract<IntrinsicApySourceConfig, { provider: 'securitize' }>

type SecuritizeResponse = {
  data?: SecuritizeAssetStats[]
}

type SecuritizeAssetStats = {
  token_address?: string
  nav_yield_30d?: string | number
  distribution_yield?: string | number
}

const normalize = (value?: string) => value?.toLowerCase() || ''

const buildSourceUrl = (symbol: string) =>
  `https://public-feed.securitize.io/asset-stats?symbol=${symbol}`

const fetchBySymbol = async (
  sources: SecuritizeSource[],
): Promise<IntrinsicApyResult[]> => {
  const req = toIntrinsicApyRequest(sources[0])
  const res = await $fetch<SecuritizeResponse>(req.path, { query: req.query })

  const entries = Array.isArray(res?.data) ? res.data : []
  const results: IntrinsicApyResult[] = []

  for (const source of sources) {
    const match = entries.find(
      e => normalize(e.token_address) === normalize(source.address),
    )
    if (!match) continue

    const raw = match[source.yieldField]
    const apy = typeof raw === 'string' ? parseFloat(raw) || 0 : (raw ?? 0)

    results.push({
      address: normalize(source.address),
      info: {
        apy,
        provider: 'Securitize',
        source: buildSourceUrl(source.symbol),
      },
    })
  }

  return results
}

export const createSecuritizeProvider = (sources: readonly IntrinsicApySourceConfig[]): IntrinsicApyProvider => {
  const securitizeSources = sources.filter(
    (s): s is SecuritizeSource => s.provider === 'securitize',
  )

  return {
    name: 'Securitize',

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = securitizeSources.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []

      const bySymbol = new Map<string, SecuritizeSource[]>()
      for (const source of chainSources) {
        const existing = bySymbol.get(source.symbol) ?? []
        bySymbol.set(source.symbol, [...existing, source])
      }

      const settled = await Promise.allSettled(
        [...bySymbol.values()].map(fetchBySymbol),
      )

      const results: IntrinsicApyResult[] = []
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(...result.value)
        }
        else {
          logWarn('intrinsicApy/securitize', result.reason)
        }
      }

      return results
    },
  }
}
