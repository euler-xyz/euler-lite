import type { IntrinsicApySourceConfig } from '~/entities/custom'
import type { IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'

type YoSource = Extract<IntrinsicApySourceConfig, { provider: 'yo' }>

type YoVaultStats = {
  data?: Array<{
    contracts?: { vaultAddress?: string }
    yield?: { '7d'?: number }
  }>
}

const normalize = (value?: string) => value?.toLowerCase() || ''

export const createYoProvider = (sources: readonly IntrinsicApySourceConfig[]): IntrinsicApyProvider => {
  const yoSources = sources.filter(
    (s): s is YoSource => s.provider === 'yo',
  )

  return {
    name: 'YO',

    async fetch(chainId: number): Promise<IntrinsicApyResult[]> {
      const chainSources = yoSources.filter(s => s.chainId === chainId)
      if (!chainSources.length) return []

      const req = toIntrinsicApyRequest(chainSources[0])
      const resp = await $fetch<YoVaultStats>(req.path, req.query ? { query: req.query } : {})
      const vaults = resp?.data ?? []

      const apyByAddress = new Map<string, number>()
      for (const vault of vaults) {
        const addr = vault.contracts?.vaultAddress
        if (addr) {
          apyByAddress.set(addr.toLowerCase(), vault.yield?.['7d'] ?? 0)
        }
      }

      return chainSources
        .filter(source => apyByAddress.has(normalize(source.address)))
        .map(source => ({
          address: normalize(source.address),
          info: {
            apy: apyByAddress.get(normalize(source.address))!,
            provider: 'YO',
            source: 'https://yo.xyz',
          },
        }))
    },
  }
}
