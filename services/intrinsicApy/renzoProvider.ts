import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'

type RenzoSource = Extract<IntrinsicApySourceConfig, { provider: 'renzo' }>

type RenzoStatsResponse = {
  data?: {
    apr?: {
      data?: { rate?: number }
      pzETHAPR?: { rate?: number }
    }
  }
}

const normalize = (value?: string) => value?.toLowerCase() || ''

export const createRenzoProvider = (sources: readonly IntrinsicApySourceConfig[]): IntrinsicApyProvider => {
  const renzoSources = sources.filter(
    (s): s is RenzoSource => s.provider === 'renzo',
  )

  return {
    name: 'Renzo',

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = renzoSources.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []

      const req = toIntrinsicApyRequest(chainSources[0])
      const data = await $fetch<RenzoStatsResponse>(req.path, req.query ? { query: req.query } : {})
      const apr = data?.data?.apr

      return chainSources.map(source => ({
        address: normalize(source.address),
        info: {
          apy: source.renzoVariant === 'pzETH'
            ? Number(apr?.pzETHAPR?.rate ?? 0)
            : Number(apr?.data?.rate ?? 0),
          provider: 'Renzo',
          source: 'https://app.renzoprotocol.com',
        },
      }))
    },
  }
}
