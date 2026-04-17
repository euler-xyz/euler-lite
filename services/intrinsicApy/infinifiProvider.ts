import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'

type InfinifiSource = Extract<IntrinsicApySourceConfig, { provider: 'infinifi' }>

type InfinifiResponse = {
  data?: {
    stats?: {
      locked?: Record<string, { average7dAPY?: number }>
      staked?: { average7dAPY?: number }
    }
  }
}

const normalize = (value?: string) => value?.toLowerCase() || ''

export const createInfinifiProvider = (sources: readonly IntrinsicApySourceConfig[]): IntrinsicApyProvider => {
  const infinifiSources = sources.filter(
    (s): s is InfinifiSource => s.provider === 'infinifi',
  )

  return {
    name: 'InfiniFi',

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = infinifiSources.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []

      const data = await $fetch<InfinifiResponse>('/api/intrinsic-apy/infinifi')
      const stats = data?.data?.stats

      return chainSources.map((source) => {
        const raw = source.infinifiVariant === 'staked'
          ? Number(stats?.staked?.average7dAPY ?? 0)
          : Number(source.infinifiLockedKey ? stats?.locked?.[source.infinifiLockedKey]?.average7dAPY ?? 0 : 0)
        const apy = raw * 100

        return {
          address: normalize(source.address),
          info: {
            apy,
            provider: 'InfiniFi',
            source: 'https://infinifi.xyz',
          },
        }
      })
    },
  }
}
