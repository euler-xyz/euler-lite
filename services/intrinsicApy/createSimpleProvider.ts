import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'

interface SimpleProviderConfig {
  readonly providerName: string
  readonly providerKey: string
  readonly extractApy: (data: unknown) => number
  readonly sourceUrl?: string
}

const normalize = (value?: string) => value?.toLowerCase() || ''

export const createSimpleProvider = (
  config: SimpleProviderConfig,
  sources: readonly IntrinsicApySourceConfig[],
): IntrinsicApyProvider => {
  const filtered = sources.filter(s => s.provider === config.providerKey)

  return {
    name: config.providerName,

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = filtered.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []

      const req = toIntrinsicApyRequest(chainSources[0])
      const data = await $fetch(req.path, req.query ? { query: req.query } : {})
      const apy = config.extractApy(data)

      if (!Number.isFinite(apy) || apy <= 0) return []

      return chainSources.map(source => ({
        address: normalize(source.address),
        info: {
          apy,
          provider: config.providerName,
          ...(config.sourceUrl && { source: config.sourceUrl }),
        },
      }))
    },
  }
}
