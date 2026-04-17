import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'

type MidasSource = Extract<IntrinsicApySourceConfig, { provider: 'midas' }>

const normalize = (value?: string) => value?.toLowerCase() || ''

export const createMidasProvider = (sources: readonly IntrinsicApySourceConfig[]): IntrinsicApyProvider => {
  const midasSources = sources.filter(
    (s): s is MidasSource => s.provider === 'midas',
  )

  return {
    name: 'Midas',

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = midasSources.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []

      const req = toIntrinsicApyRequest(chainSources[0])
      const data = await $fetch<Record<string, number>>(req.path, req.query ? { query: req.query } : {})

      return chainSources
        .filter(source => data[source.midasKey] !== undefined)
        .map(source => ({
          address: normalize(source.address),
          info: {
            apy: Number(data[source.midasKey]) * 100,
            provider: 'Midas',
            source: 'https://midas.app',
          },
        }))
    },
  }
}
