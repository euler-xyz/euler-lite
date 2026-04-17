import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'
import { STABLEWATCH_SOURCE_URL } from '~/entities/constants'
import { logWarn } from '~/utils/errorHandling'

type StablewatchSource = Extract<IntrinsicApySourceConfig, { provider: 'stablewatch' }>

type StablewatchResponse = {
  data?: StablewatchPool[]
}

type StablewatchPool = {
  metrics?: {
    apy?: {
      avg7d?: number | string
    }
  }
  token?: {
    chains?: Record<string, string[]>
  }
}

const CHAIN_ID_TO_NAME: Record<number, string> = {
  1: 'ethereum',
  56: 'bnbsmartchain',
  146: 'sonic',
  239: 'tac',
  8453: 'base',
  9745: 'plasma',
  42161: 'arbitrumone',
  43114: 'avalanche',
  59144: 'lineamainnet',
}

const normalize = (value?: string) => value?.toLowerCase() || ''

const normalizeChainName = (raw: string): string => {
  const trimmed = raw.toLowerCase().replace(/\s+/g, '')
  if (trimmed === 'binance-smart-chain') return 'bnbsmartchain'
  if (trimmed === 'linea') return 'lineamainnet'
  if (trimmed === 'arbitrum') return 'arbitrumone'
  return trimmed
}

const buildLookupKey = (chain: string, address: string) =>
  `${chain.toLowerCase()}:${address.toLowerCase()}`

export const createStablewatchProvider = (sources: readonly IntrinsicApySourceConfig[]): IntrinsicApyProvider => {
  const stablewatchSources = sources.filter(
    (s): s is StablewatchSource => s.provider === 'stablewatch',
  )

  return {
    name: 'Stablewatch',

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = stablewatchSources.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []

      const chainName = CHAIN_ID_TO_NAME[chainId]
      if (!chainName) return []

      try {
        const req = toIntrinsicApyRequest(chainSources[0])
        const resp = await $fetch<StablewatchResponse>(req.path, req.query ? { query: req.query } : {})
        const pools = Array.isArray(resp?.data) ? resp.data : []

        const lookup = new Map<string, number>()
        for (const pool of pools) {
          const apyRaw = pool.metrics?.apy?.avg7d
          const apy = typeof apyRaw === 'number' ? apyRaw : Number(apyRaw)
          if (!Number.isFinite(apy) || !pool.token?.chains) continue

          for (const [rawChainName, addresses] of Object.entries(pool.token.chains)) {
            if (!Array.isArray(addresses)) continue
            const normalizedChain = normalizeChainName(rawChainName)
            for (const addr of addresses) {
              if (typeof addr !== 'string') continue
              lookup.set(buildLookupKey(normalizedChain, addr), Math.max(0, apy))
            }
          }
        }

        const results: IntrinsicApyResult[] = []
        for (const source of chainSources) {
          const key = buildLookupKey(chainName, source.address)
          const apy = lookup.get(key)
          if (apy === undefined) continue

          results.push({
            address: normalize(source.address),
            info: {
              apy,
              provider: 'Stablewatch',
              source: STABLEWATCH_SOURCE_URL,
            },
          })
        }

        return results
      }
      catch (err) {
        logWarn('intrinsicApy/stablewatch', err)
        return []
      }
    },
  }
}
