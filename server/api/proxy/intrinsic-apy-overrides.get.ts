import { createError, getMethod, getQuery, setResponseHeaders } from 'h3'
import type { Address } from 'viem'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logger } from '~/server/utils/logger'
import {
  extractHyperbeatWeightedApr,
  extractLatestYuzuApy,
  extractValantisApy,
  type IntrinsicApyOverrideRow,
} from '~/utils/yuzu-intrinsic-apy'

const ALLOWED_METHODS = new Set(['GET', 'HEAD'])
const PENDLE_STALE_MS = 7 * 24 * 60 * 60 * 1000

const URLS = {
  defillama: 'https://yields.llama.fi/pools',
  hyperbeat: 'https://api.hyperbeat.org/api/v1/staking?address=0xCeaD893b162D38e714D82d06a7fe0b0dc3c38E0b',
  kinetiq: 'https://api-v2.pendle.finance/core/v2/999/markets/0x31104779b2a07a273d6c662419377773083d0b2e/data',
  lhype: 'https://app.loopingcollective.org/api/external/asset/lhype',
  lsthype: 'https://api.hyperbeat.org/api/v1/vaults/apy/0x81e064d0eB539de7c3170EDF38C1A42CBd752A76',
  noon: 'https://back.noon.capital/api/v1/protocol-metrics',
  pendleKHype: 'https://api-v2.pendle.finance/core/v2/999/markets/0x31104779b2a07a273d6c662419377773083d0b2e/data',
  valantis: 'https://analytics-v3.valantis-analytics.xyz/sthype/apr',
  yuzuDashboard: 'https://yuzu-accountable.yuzu.money/v1/dashboard',
} as const

const rateLimiter = createRateLimiter({
  max: 300,
  windowMs: 60_000,
  label: 'intrinsic-apy-overrides-proxy',
})

const hyperevmDefillamaSources = [
  { address: '0x4de03ca1f02591b717495cfa19913ad56a2f5858', poolId: '88c6f0fd-5371-4b60-8032-ddf168b4bdd6' },
  { address: '0x9b3a8f7cec208e247d97dee13313690977e24459', poolId: 'f65159b4-7bec-40c8-8f31-1fa2f5408738' },
  { address: '0xac962fa04bf91b7fd0dc0c5c32414e0ce3c51e03', poolId: '84e38fd1-024f-4107-a1fc-0ae8bfc1b195' },
  { address: '0x34c07f50c4f55b322e85deeb265d278e6af112e4', poolId: '570ddae7-acae-4277-905b-278cd994b08d' },
] as const

const json = async <T>(url: string): Promise<T> => {
  const response = await fetchWithTimeout(url, undefined, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${url.split('?')[0]} returned ${response.status}`)
  return response.json() as Promise<T>
}

const text = async (url: string): Promise<string> => {
  const response = await fetchWithTimeout(url, undefined, { headers: { accept: 'text/plain,application/json' } })
  if (!response.ok) throw new Error(`${url.split('?')[0]} returned ${response.status}`)
  return response.text()
}

const row = (
  chainId: number,
  address: string,
  apy: number,
  provider: string,
  source: string,
): IntrinsicApyOverrideRow | null => {
  if (!Number.isFinite(apy) || apy <= 0) return null
  return { chainId, address: address as Address, apy, provider, source }
}

const safe = async <T>(label: string, fn: () => Promise<T | null>): Promise<T | null> => {
  try {
    return await fn()
  }
  catch (err) {
    logger.warn({ ctx: 'intrinsic-apy-overrides', label, err }, 'upstream fetch failed')
    return null
  }
}

const formatDefiLlamaProject = (project?: string) =>
  project ? `${project.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} via DefiLlama` : 'DefiLlama'

const fetchYuzu = async (): Promise<IntrinsicApyOverrideRow[]> => {
  const data = await json<{ data?: { reserves?: { timeline?: Array<Record<string, unknown>> } } }>(URLS.yuzuDashboard)
  const apy = extractLatestYuzuApy(data.data?.reserves?.timeline, 'yzprime_apy_7d')
  const result = row(143, '0xc9ea90692757831d98Ac629F2A0140E02b80A7DA', apy ?? 0, 'Yuzu', URLS.yuzuDashboard)
  return result ? [result] : []
}

const fetchHyperevmDefillama = async (): Promise<IntrinsicApyOverrideRow[]> => {
  const data = await json<{ data?: Array<{ pool?: string, project?: string, apy?: number | null }> }>(URLS.defillama)
  const pools = new Map((data.data ?? []).filter(p => p.pool).map(p => [p.pool!, p]))
  return hyperevmDefillamaSources.flatMap((source) => {
    const pool = pools.get(source.poolId)
    const result = row(999, source.address, pool?.apy ?? 0, formatDefiLlamaProject(pool?.project), `https://defillama.com/yields/pool/${source.poolId}`)
    return result ? [result] : []
  })
}

const fetchHyperevm = async (): Promise<IntrinsicApyOverrideRow[]> => {
  const items = await Promise.all([
    safe('valantis', async () => row(999, '0x94e8396e0869c9f2200760af0621afd240e1cf38', extractValantisApy(await text(URLS.valantis)), 'VALANTIS', URLS.valantis)),
    safe('kinetiq', async () => {
      const data = await json<{ underlyingApy?: string | number }>(URLS.kinetiq)
      return row(999, '0xfd739d4e423301ce9385c1fb8850539d657c296d', Number(data.underlyingApy ?? 0) * 100, 'KINETIQ', URLS.kinetiq)
    }),
    safe('hyperbeat', async () => row(999, '0xd8fc8f0b03eba61f64d08b0bef69d80916e5dda9', extractHyperbeatWeightedApr(await json(URLS.hyperbeat)), 'HYPERBEAT', URLS.hyperbeat)),
    safe('lhype', async () => {
      const data = await json<{ result?: { reward_rate?: string | number }, success?: boolean }>(URLS.lhype)
      return row(999, '0x5748ae796ae46a4f1348a1693de4b50560485562', data.success === false ? 0 : Number(data.result?.reward_rate ?? 0), 'LHYPE', URLS.lhype)
    }),
    safe('lsthype', async () => {
      const data = await json<{ success?: boolean, current_apy?: { apy_7d?: string | number } }>(URLS.lsthype)
      return row(999, '0x81e064d0eb539de7c3170edf38c1a42cbd752a76', data.success === false ? 0 : Number(data.current_apy?.apy_7d ?? 0), 'LSTHYPE', URLS.lsthype)
    }),
    safe('noon', async () => {
      const data = await json<{ apy?: string | number }>(URLS.noon)
      return row(999, '0x34a2798d47b238a7cba9d87d49618dee6c4d999f', Number(data.apy ?? 0), 'NOON', URLS.noon)
    }),
    safe('pendle-khype', async () => {
      const data = await json<{ impliedApy?: number, timestamp?: string }>(URLS.pendleKHype)
      const stale = !data.timestamp || Date.now() - new Date(data.timestamp).getTime() > PENDLE_STALE_MS
      return row(999, '0xea84ca9849d9e76a78b91f221f84e9ca065fc9f5', stale ? 0 : (data.impliedApy ?? 0) * 100, 'Pendle', 'https://app.pendle.finance/trade/markets')
    }),
    safe('defillama', fetchHyperevmDefillama),
  ])

  return items.flatMap(item => Array.isArray(item) ? item : item ? [item] : [])
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  await rateLimiter.consume(event)

  const chainId = Number(getQuery(event).chainId)
  if (!Number.isFinite(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'chainId is required' })
  }

  setResponseHeaders(event, {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=300',
  })

  if (method === 'HEAD') return undefined
  if (chainId === 143) return await fetchYuzu()
  if (chainId === 999) return await fetchHyperevm()
  return []
})
