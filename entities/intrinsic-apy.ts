import type { IntrinsicApySourceConfig } from '~/entities/custom'

export interface IntrinsicApyInfo {
  readonly apy: number
  readonly provider: string
  readonly source?: string
}

export const EMPTY_INTRINSIC_APY: IntrinsicApyInfo = { apy: 0, provider: '' }

export interface IntrinsicApyProvider {
  readonly name: string
  fetch(chainId: number): Promise<IntrinsicApyResult[]>
}

export interface IntrinsicApyResult {
  /** Lowercase token address */
  readonly address: string
  readonly info: IntrinsicApyInfo
}

/**
 * `$fetch` shape for hitting the `/api/intrinsic-apy/*` proxy. Single source
 * of truth for the client→proxy request contract — used by every client
 * provider that loads APY data and by the server warm-cache that pre-populates
 * the TTL caches. Keeps routing knowledge in exactly one place.
 */
export interface IntrinsicApyRequest {
  readonly path: string
  readonly query?: Record<string, string | number>
}

export const toIntrinsicApyRequest = (source: IntrinsicApySourceConfig): IntrinsicApyRequest => {
  switch (source.provider) {
    case 'pendle':
      return {
        path: '/api/intrinsic-apy/pendle',
        query: {
          chainId: source.crossChainSourceChainId ?? source.chainId,
          market: source.pendleMarket,
        },
      }
    case 'securitize':
      return {
        path: '/api/intrinsic-apy/securitize',
        query: { symbol: source.symbol },
      }
    default:
      return { path: `/api/intrinsic-apy/${source.provider}` }
  }
}
