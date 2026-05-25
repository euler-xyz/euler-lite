import type { Address } from 'viem'
import type { ERC4626Vault, IIntrinsicApyService, IntrinsicApyInfo } from '@eulerxyz/euler-v2-sdk'

export const YUZU_CHAIN_ID = 143
export const YUZU_ASSET_ADDRESS = '0xc9ea90692757831d98Ac629F2A0140E02b80A7DA' as Address
const OVERRIDE_CACHE_TTL_MS = 5 * 60 * 1000

export type YuzuApyField = 'yzprime_apy_1d' | 'yzprime_apy_7d' | 'yzprime_apy_30d'
export type YuzuDashboardTimelineRow = {
  date?: string
  ts?: string | number
} & Partial<Record<YuzuApyField, string | number | null>>

export type HyperbeatStakingResponse = {
  data?: {
    delegations?: Array<{
      apr?: string | number
      amount?: string | number
      status?: string
    }>
  }
}

export type IntrinsicApyOverrideRow = IntrinsicApyInfo & {
  chainId: number
  address: Address
}

const yuzuDateValue = (date?: string): number => {
  if (!date) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

const yuzuTimestampValue = (ts?: string | number): number => {
  const parsed = Number(ts)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

export const extractLatestYuzuApy = (
  rows: readonly YuzuDashboardTimelineRow[] | undefined,
  field: YuzuApyField,
): number | null => {
  let latest: YuzuDashboardTimelineRow | undefined
  for (const row of rows ?? []) {
    if (!row) continue
    if (!latest) {
      latest = row
      continue
    }
    const rowDate = yuzuDateValue(row.date)
    const latestDate = yuzuDateValue(latest.date)
    if (
      rowDate > latestDate
      || (rowDate === latestDate && yuzuTimestampValue(row.ts) > yuzuTimestampValue(latest.ts))
    ) {
      latest = row
    }
  }

  const apy = Number(latest?.[field])
  return Number.isFinite(apy) ? apy : null
}

export const extractValantisApy = (data: string | number): number => Number(data)

export const extractHyperbeatWeightedApr = (data: HyperbeatStakingResponse): number => {
  let totalWeightedApr = 0
  let totalAmount = 0

  for (const delegation of data.data?.delegations ?? []) {
    if (delegation.status !== 'active') continue
    const amount = Number(delegation.amount ?? 0)
    const apr = Number(delegation.apr ?? 0)
    if (!Number.isFinite(amount) || !Number.isFinite(apr)) continue
    totalWeightedApr += apr * amount
    totalAmount += amount
  }

  return totalAmount > 0 ? totalWeightedApr / totalAmount : 0
}

const appendChainId = (baseUrl: string, chainId: number): string => {
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}chainId=${encodeURIComponent(String(chainId))}`
}

const rowsToMap = (rows: readonly IntrinsicApyOverrideRow[]): Map<string, IntrinsicApyInfo> => {
  const out = new Map<string, IntrinsicApyInfo>()
  for (const row of rows) {
    if (!row.address || typeof row.apy !== 'number' || !row.provider) continue
    out.set(row.address.toLowerCase(), {
      apy: row.apy,
      provider: row.provider,
      source: row.source,
    })
  }
  return out
}

export const createYuzuIntrinsicApyService = (
  base: IIntrinsicApyService,
  overridesUrl: string,
): IIntrinsicApyService => {
  const cache = new Map<number, { expiresAt: number, value: Map<string, IntrinsicApyInfo> }>()
  const inFlight = new Map<number, Promise<Map<string, IntrinsicApyInfo>>>()

  const fetchOverrides = async (chainId: number): Promise<Map<string, IntrinsicApyInfo>> => {
    const now = Date.now()
    const cached = cache.get(chainId)
    if (cached && cached.expiresAt > now) return cached.value
    const existing = inFlight.get(chainId)
    if (existing) return existing

    const request = (async () => {
      try {
        const response = await fetch(appendChainId(overridesUrl, chainId), { headers: { accept: 'application/json' } })
        if (!response.ok) return new Map<string, IntrinsicApyInfo>()
        const rows = await response.json() as IntrinsicApyOverrideRow[]
        return rowsToMap(Array.isArray(rows) ? rows : [])
      }
      finally {
        inFlight.delete(chainId)
      }
    })()

    inFlight.set(chainId, request)
    const value = await request
    cache.set(chainId, { expiresAt: Date.now() + OVERRIDE_CACHE_TTL_MS, value })
    return value
  }

  const service: IIntrinsicApyService = {
    async fetchIntrinsicApy(chainId: number, assetAddress: Address) {
      const [baseResult, overrideResult] = await Promise.allSettled([
        base.fetchIntrinsicApy(chainId, assetAddress),
        fetchOverrides(chainId),
      ])

      const overrides = overrideResult.status === 'fulfilled' ? overrideResult.value : undefined
      const override = overrides?.get(assetAddress.toLowerCase())
      if (override) return override
      if (baseResult.status === 'fulfilled') return baseResult.value
      throw baseResult.reason
    },

    async fetchChainIntrinsicApys(chainId: number) {
      const [baseResult, overrideResult] = await Promise.allSettled([
        base.fetchChainIntrinsicApys(chainId),
        fetchOverrides(chainId),
      ])

      const out = baseResult.status === 'fulfilled'
        ? new Map(baseResult.value)
        : new Map<string, IntrinsicApyInfo>()
      const overrides = overrideResult.status === 'fulfilled' ? overrideResult.value : undefined
      for (const [address, info] of overrides ?? []) out.set(address, info)
      if (out.size > 0 || baseResult.status === 'fulfilled') return out
      throw baseResult.reason
    },

    async populateIntrinsicApy(vaults: ERC4626Vault[]) {
      if (vaults.length === 0) return
      const byChain = new Map<number, ERC4626Vault[]>()
      for (const vault of vaults) {
        const chainVaults = byChain.get(vault.chainId) ?? []
        chainVaults.push(vault)
        byChain.set(vault.chainId, chainVaults)
      }

      await Promise.all(Array.from(byChain.entries()).map(async ([chainId, chainVaults]) => {
        const apyMap = await service.fetchChainIntrinsicApys(chainId)
        for (const vault of chainVaults) {
          const info = apyMap.get(vault.asset.address.toLowerCase())
          if (info) vault.intrinsicApy = info
          vault.populated.intrinsicApy = true
        }
      }))
    },
  }

  return service
}
